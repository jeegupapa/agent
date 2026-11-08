// 직원·작업 목록 저장소. 로그인되어 있으면 Firestore(users/{uid}/employees, tasks), 아니면 localStorage.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Employee, TeamTask } from '../../../shared/types'
import * as fb from '../firebase'

const LOCAL_KEY = 'claude-cli-studio.team'

interface LocalTeam {
  employees: Employee[]
  tasks: TeamTask[]
}

function loadLocal(): LocalTeam {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalTeam>
      return { employees: parsed.employees ?? [], tasks: parsed.tasks ?? [] }
    }
  } catch {
    /* 무시 */
  }
  return { employees: [], tasks: [] }
}

function saveLocal(team: LocalTeam): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(team))
  } catch {
    /* 무시 */
  }
}

export interface TeamStore {
  employees: Employee[]
  tasks: TeamTask[]
  /** 'firestore' | 'local' */
  backend: 'firestore' | 'local'
  error?: string
  upsertEmployee: (e: Employee) => void
  removeEmployee: (id: string) => void
  upsertTask: (t: TeamTask) => void
  patchTask: (id: string, patch: Partial<TeamTask> | ((t: TeamTask) => Partial<TeamTask>)) => void
  removeTask: (id: string) => void
}

export function useTeamStore(user: fb.FbUser | null, firebaseEnabled: boolean): TeamStore {
  const useFs = !!user && firebaseEnabled && fb.isReady()
  const [local, setLocal] = useState<LocalTeam>(loadLocal)
  const [remote, setRemote] = useState<LocalTeam>({ employees: [], tasks: [] })
  const [error, setError] = useState<string | undefined>()
  const migrated = useRef(false)

  // 로컬 변경은 항상 저장
  useEffect(() => saveLocal(local), [local])

  // Firestore 구독
  useEffect(() => {
    if (!useFs || !user) {
      setRemote({ employees: [], tasks: [] })
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
    return () => {
      offE()
      offT()
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

  // 현재 보이는 목록 (원격 우선)
  const current: LocalTeam = useFs ? remote : local
  const currentRef = useRef(current)
  currentRef.current = current

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
    backend: useFs ? 'firestore' : 'local',
    error,
    upsertEmployee,
    removeEmployee,
    upsertTask,
    patchTask,
    removeTask
  }
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i < 0) return [item, ...list]
  const next = list.slice()
  next[i] = item
  return next
}
