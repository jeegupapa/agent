// 직원·작업·팀 목록 저장소. 로그인되어 있으면 Firestore(users/{uid}/employees, tasks, teams), 아니면 localStorage.
//
// 팀은 세션마다 따로 꾸린다. 직원과 작업에는 속한 팀의 id(teamId)가 붙고, 화면에는 지금 세션의 팀 것만 보인다.
// teamId 가 없는 것은 세션별 팀이 생기기 전에 만든 것으로, "기존 팀"(DEFAULT_TEAM_ID)에 속한다.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_TEAM_ID, type Employee, type TeamInfo, type TeamTask } from '../../../shared/types'
import * as fb from '../firebase'

const LOCAL_KEY = 'claude-cli-studio.team'

interface LocalTeam {
  employees: Employee[]
  tasks: TeamTask[]
  teams: TeamInfo[]
}

const EMPTY: LocalTeam = { employees: [], tasks: [], teams: [] }

function loadLocal(): LocalTeam {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalTeam>
      return { employees: parsed.employees ?? [], tasks: parsed.tasks ?? [], teams: parsed.teams ?? [] }
    }
  } catch {
    /* 무시 */
  }
  return EMPTY
}

function saveLocal(team: LocalTeam): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(team))
  } catch {
    /* 무시 */
  }
}

/** 직원·작업이 속한 팀 id (teamId 가 없으면 기존 팀) */
export function teamOf(x: { teamId?: string }): string {
  return x.teamId ?? DEFAULT_TEAM_ID
}

export interface TeamStore {
  /** 모든 팀의 직원·작업 */
  employees: Employee[]
  tasks: TeamTask[]
  /** 이름이 저장된 팀 목록 (직원이나 작업이 처음 생길 때 만들어진다) */
  teams: TeamInfo[]
  /** 'firestore' | 'local' */
  backend: 'firestore' | 'local'
  error?: string
  upsertEmployee: (e: Employee) => void
  removeEmployee: (id: string) => void
  upsertTask: (t: TeamTask) => void
  patchTask: (id: string, patch: Partial<TeamTask> | ((t: TeamTask) => Partial<TeamTask>)) => void
  removeTask: (id: string) => void
  upsertTeam: (t: TeamInfo) => void
  /** 팀과 그 팀의 직원·작업을 모두 지운다 */
  removeTeam: (id: string) => void
}

export function useTeamStore(user: fb.FbUser | null, firebaseEnabled: boolean): TeamStore {
  const useFs = !!user && firebaseEnabled && fb.isReady()
  const [local, setLocal] = useState<LocalTeam>(loadLocal)
  const [remote, setRemote] = useState<LocalTeam>(EMPTY)
  const [error, setError] = useState<string | undefined>()
  const migrated = useRef(false)

  // 로컬 변경은 항상 저장
  useEffect(() => saveLocal(local), [local])

  // Firestore 구독
  useEffect(() => {
    if (!useFs || !user) {
      setRemote(EMPTY)
      return
    }
    setError(undefined)
    const offE = fb.subscribeCollection<Employee>(
      user.uid,
      'employees',
      (list) => setRemote((r) => ({ ...r, employees: list.sort((a, b) => a.createdAt - b.createdAt) })),
      (e) => setError(e.message)
    )
    const offT = fb.subscribeCollection<TeamTask>(
      user.uid,
      'tasks',
      (list) => setRemote((r) => ({ ...r, tasks: list.sort((a, b) => b.createdAt - a.createdAt) })),
      (e) => setError(e.message)
    )
    const offG = fb.subscribeCollection<TeamInfo>(
      user.uid,
      'teams',
      (list) => setRemote((r) => ({ ...r, teams: list.sort((a, b) => b.createdAt - a.createdAt) })),
      (e) => setError(e.message)
    )
    return () => {
      offE()
      offT()
      offG()
    }
  }, [useFs, user])

  // 처음 로그인했을 때 로컬에만 있던 데이터를 올려 준다 (원격이 비어 있을 때 한 번)
  useEffect(() => {
    if (!useFs || !user || migrated.current) return
    if (remote.employees.length === 0 && remote.tasks.length === 0 && (local.employees.length || local.tasks.length)) {
      migrated.current = true
      const t = setTimeout(() => {
        for (const e of local.employees) void fb.setDocument(user.uid, 'employees', e.id, e)
        for (const task of local.tasks) void fb.setDocument(user.uid, 'tasks', task.id, task)
        for (const team of local.teams) void fb.setDocument(user.uid, 'teams', team.id, team)
      }, 1500)
      return () => clearTimeout(t)
    }
    return
  }, [useFs, user, remote, local])

  const upsertEmployee = useCallback(
    (e: Employee) => {
      setLocal((l) => ({ ...l, employees: upsert(l.employees, e) }))
      if (useFs && user) fb.setDocument(user.uid, 'employees', e.id, e).catch((err) => setError(String(err)))
    },
    [useFs, user]
  )
  const removeEmployee = useCallback(
    (id: string) => {
      setLocal((l) => ({ ...l, employees: l.employees.filter((x) => x.id !== id) }))
      if (useFs && user) fb.deleteDocument(user.uid, 'employees', id).catch((err) => setError(String(err)))
    },
    [useFs, user]
  )
  const upsertTask = useCallback(
    (t: TeamTask) => {
      setLocal((l) => ({ ...l, tasks: upsert(l.tasks, t) }))
      if (useFs && user) fb.setDocument(user.uid, 'tasks', t.id, t).catch((err) => setError(String(err)))
    },
    [useFs, user]
  )
  const removeTask = useCallback(
    (id: string) => {
      setLocal((l) => ({ ...l, tasks: l.tasks.filter((x) => x.id !== id) }))
      if (useFs && user) fb.deleteDocument(user.uid, 'tasks', id).catch((err) => setError(String(err)))
    },
    [useFs, user]
  )
  const upsertTeam = useCallback(
    (t: TeamInfo) => {
      setLocal((l) => ({ ...l, teams: upsert(l.teams, t) }))
      if (useFs && user) fb.setDocument(user.uid, 'teams', t.id, t).catch((err) => setError(String(err)))
    },
    [useFs, user]
  )

  // 현재 보이는 목록 (원격 우선)
  const current: LocalTeam = useFs ? remote : local
  const currentRef = useRef(current)
  currentRef.current = current

  const removeTeam = useCallback(
    (id: string) => {
      const cur = currentRef.current
      const emps = cur.employees.filter((e) => teamOf(e) === id).map((e) => e.id)
      const tasks = cur.tasks.filter((t) => teamOf(t) === id).map((t) => t.id)
      setLocal((l) => ({
        employees: l.employees.filter((e) => teamOf(e) !== id),
        tasks: l.tasks.filter((t) => teamOf(t) !== id),
        teams: l.teams.filter((t) => t.id !== id)
      }))
      if (useFs && user) {
        for (const e of emps) fb.deleteDocument(user.uid, 'employees', e).catch((err) => setError(String(err)))
        for (const t of tasks) fb.deleteDocument(user.uid, 'tasks', t).catch((err) => setError(String(err)))
        fb.deleteDocument(user.uid, 'teams', id).catch((err) => setError(String(err)))
      }
    },
    [useFs, user]
  )

  const patchTask = useCallback(
    (id: string, patch: Partial<TeamTask> | ((t: TeamTask) => Partial<TeamTask>)) => {
      const t = currentRef.current.tasks.find((x) => x.id === id) ?? local.tasks.find((x) => x.id === id)
      if (!t) return
      const p = typeof patch === 'function' ? patch(t) : patch
      upsertTask({ ...t, ...p })
    },
    [upsertTask, local.tasks]
  )

  return {
    employees: current.employees,
    tasks: current.tasks,
    teams: current.teams,
    backend: useFs ? 'firestore' : 'local',
    error,
    upsertEmployee,
    removeEmployee,
    upsertTask,
    patchTask,
    removeTask,
    upsertTeam,
    removeTeam
  }
}

/** 팀 선택 상자에 넣을 한 줄 */
export interface TeamRow {
  id: string
  name: string
  createdAt: number
  employees: number
  running: number
  attention: number
}

const ACTIVE = ['running', 'waiting_permission', 'changes_requested']
const ATTENTION = ['needs_review', 'waiting_permission', 'failed']

/** 새로 만든 팀의 임시 이름. 세션에 첫 메시지가 생기면 그 제목으로 바뀐다 */
export function autoTeamName(now = Date.now()): string {
  const d = new Date(now)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())} 세션의 팀`
}

export interface ScopedTeam {
  /** 지금 세션의 팀 id */
  teamId: string
  /** 이 팀의 직원·작업 */
  employees: Employee[]
  tasks: TeamTask[]
  /** 팀 목록 (지금 팀은 아직 비어 있어도 들어 있다). 최근에 만든 순 */
  rows: TeamRow[]
  /** 새 직원·작업이면 지금 팀에 넣고, 이미 있는 것이면 속한 팀을 그대로 둔다 */
  upsertEmployee: (e: Employee) => void
  upsertTask: (t: TeamTask) => void
  /** 다른 팀의 직원을 지금 팀으로 복사 (같은 직함·이름이 이미 있으면 건너뛴다). 복사한 수를 돌려준다 */
  importEmployees: (fromTeamId: string) => number
}

/** 저장소 전체에서 한 팀만 골라 보는 뷰. 지금 세션의 팀에 새 직원·작업을 넣는 일을 맡는다 */
export function useScopedTeam(store: TeamStore, teamId: string): ScopedTeam {
  const storeRef = useRef(store)
  storeRef.current = store

  const employees = useMemo(() => store.employees.filter((e) => teamOf(e) === teamId), [store.employees, teamId])
  const tasks = useMemo(() => store.tasks.filter((t) => teamOf(t) === teamId), [store.tasks, teamId])

  const rows = useMemo<TeamRow[]>(() => {
    const ids = new Set<string>([teamId])
    for (const t of store.teams) ids.add(t.id)
    for (const e of store.employees) ids.add(teamOf(e))
    for (const t of store.tasks) ids.add(teamOf(t))
    return [...ids]
      .map((id) => {
        const info = store.teams.find((t) => t.id === id)
        const mine = store.tasks.filter((t) => teamOf(t) === id)
        const emps = store.employees.filter((e) => teamOf(e) === id).length
        return {
          id,
          name: info?.name ?? (id === DEFAULT_TEAM_ID ? '기존 팀' : emps + mine.length === 0 ? '새 팀 (아직 비어 있음)' : '이름 없는 팀'),
          createdAt: info?.createdAt ?? (id === DEFAULT_TEAM_ID ? 0 : Date.now()),
          employees: emps,
          running: mine.filter((t) => ACTIVE.includes(t.status)).length,
          attention: mine.filter((t) => ATTENTION.includes(t.status)).length
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [store.teams, store.employees, store.tasks, teamId])

  /** 지금 팀에 처음으로 무언가를 넣을 때 팀 이름을 저장해 둔다 */
  const ensureTeam = useCallback((): void => {
    if (teamId === DEFAULT_TEAM_ID || storeRef.current.teams.some((t) => t.id === teamId)) return
    const now = Date.now()
    storeRef.current.upsertTeam({ id: teamId, name: autoTeamName(now), createdAt: now, autoName: true })
  }, [teamId])

  const stamp = teamId === DEFAULT_TEAM_ID ? undefined : teamId

  const upsertEmployee = useCallback(
    (e: Employee) => {
      const s = storeRef.current
      if (s.employees.some((x) => x.id === e.id)) return s.upsertEmployee(e)
      ensureTeam()
      s.upsertEmployee({ ...e, teamId: e.teamId ?? stamp })
    },
    [ensureTeam, stamp]
  )
  const upsertTask = useCallback(
    (t: TeamTask) => {
      const s = storeRef.current
      if (s.tasks.some((x) => x.id === t.id)) return s.upsertTask(t)
      ensureTeam()
      s.upsertTask({ ...t, teamId: t.teamId ?? stamp })
    },
    [ensureTeam, stamp]
  )
  const importEmployees = useCallback(
    (fromTeamId: string): number => {
      const s = storeRef.current
      const mine = s.employees.filter((e) => teamOf(e) === teamId)
      const now = Date.now()
      let n = 0
      for (const e of s.employees.filter((x) => teamOf(x) === fromTeamId)) {
        if (mine.some((m) => m.role === e.role && m.name === e.name)) continue
        if (n === 0) ensureTeam()
        s.upsertEmployee({ ...e, id: crypto.randomUUID(), teamId: stamp, createdAt: now + n, updatedAt: now })
        n++
      }
      return n
    },
    [teamId, ensureTeam, stamp]
  )

  return { teamId, employees, tasks, rows, upsertEmployee, upsertTask, importEmployees }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i < 0) return [item, ...list]
  const next = list.slice()
  next[i] = item
  return next
}
