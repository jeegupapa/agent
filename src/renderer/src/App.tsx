import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AppConfig,
  AppConfigView,
  Attachment,
  AuthStatus,
  BgTask,
  DispatchAssignment,
  EffortLevel,
  ClaudeEvent,
  Employee,
  TeamTask,
  PermissionRequest,
  PermissionMode,
  ReviewDecision,
  PlanWindow,
  SavedSessionMeta,
  SessionInfo,
  ToolCallRecord,
  UpdateStatus,
  UsageSummary
} from '../../shared/types'
import {
  DEFAULT_TEAM_ID,
  DEFAULT_TEAM_LIMITS,
  DISPATCH_TASK_ID,
  EMPLOYEE_PRESETS,
  type MemoryItem,
  type TeamLimits,
  type TeamUsage
} from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { SearchDialog } from './components/SearchDialog'
import { MemoryDialog } from './memory/MemoryDialog'
import { activeMemories, parseRememberCommand, renderMemory, useMemoryStore } from './memory/store'
import { Chat, type ChatItem } from './components/Chat'
import { ToolLog } from './components/ToolLog'
import { DiffPanel } from './components/DiffPanel'
import { TerminalPanel } from './components/TerminalPanel'
import { BrowserPanel } from './components/BrowserPanel'
import { FolderPanel } from './components/FolderPanel'
import { PermissionDialog } from './components/PermissionDialog'
import { SettingsDialog } from './components/SettingsDialog'
import type { SyncState } from './components/FirebasePanel'
import * as fb from './firebase'
import { Resizer } from './components/Resizer'
import { TeamView } from './team/TeamView'
import { BackgroundPanel, visibleBgTasks, type BgScope } from './components/BackgroundPanel'
import { isTeamAware, renderDecisions, renderReports, renderRoster, renderTeamStatus } from './team/status'
import {
  MAX_AUTO_ROUNDS,
  MAX_DEPTH,
  MAX_HANDOFF_BACK,
  MAX_PEER_ROUNDS,
  MAX_TEAM_TASKS,
  parseCoordination,
  type Coordination
} from '../../shared/delegate'
import { teamOf, useScopedTeam, useTeamStore } from './team/store'
import { AUTO, legacyToAuto } from '../../shared/models'
import {
  EMPTY_RUNTIME,
  applyEvent,
  depthOf,
  deriveTaskPatch,
  isActive,
  isAsk,
  isSettled,
  limitReached,
  needsUser,
  parentOf,
  rootOf,
  subtreeOf,
  treeStats,
  type TaskRuntime
} from './team/runtime'
import {
  DEFAULT_LAYOUT,
  LIMITS,
  clamp,
  loadLayout,
  maxRightWidth,
  maxSidebarWidth,
  saveLayout,
  type PanelLayout
} from './layout'

export interface PlanUsage {
  windows: PlanWindow[]
  isUsingOverage: boolean
  updatedAt: number
}

type RightTab = 'tools' | 'diff' | 'tasks' | 'terminal' | 'browser' | 'files'

/** 중단된 작업을 같은 세션에서 이어 갈 때 보내는 지시 */
const RESUME_PROMPT =
  '# 작업 재개\n\n중단됐던 작업을 이어서 진행하세요. 이미 끝낸 부분은 다시 하지 말고, 먼저 지금 파일 상태를 확인한 뒤 남은 부분을 마무리하세요. 끝나면 "## 보고" 형식으로 보고하세요.'

/** 마지막 작업 폴더 (다음 실행 때 복원) */
const CWD_KEY = 'claude-cli-studio.cwd'
const MODEL_MIGRATED_KEY = 'claude-cli-studio.model-auto-migrated'
/** 자동 모델 선택이 들어간 시점 (v0.7.5). 이보다 먼저 저장된 직원 설정만 자동 선택으로 옮긴다 */
const MODEL_AUTO_CUTOFF = Date.UTC(2026, 10, 11)

const EMPTY_TEAM_USAGE: TeamUsage = { runs: 0, numTurns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 0, totalCostUsd: 0 }
type SettingsTab = 'auth' | 'mcp' | 'skills' | 'update' | 'firebase' | 'memory'

const EMPTY_USAGE: UsageSummary = {
  totalCostUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  durationMs: 0,
  numTurns: 0
}

export default function App() {
  const [cwd, setCwd] = useState('')
  const [sessionId, setSessionId] = useState<string | undefined>()
  const [session, setSession] = useState<SessionInfo | null>(null)
  const [config, setConfig] = useState<AppConfigView | null>(null)
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null)
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default')
  const [running, setRunning] = useState(false)
  const [status, setStatus] = useState('')
  const [items, setItems] = useState<ChatItem[]>([])
  const [toolCalls, setToolCalls] = useState<ToolCallRecord[]>([])
  const [usage, setUsage] = useState<UsageSummary>(EMPTY_USAGE)
  const [plan, setPlan] = useState<PlanUsage | null>(null)
  // 앱 실행 이후 팀(직원·팀장) 세션이 쓴 사용량. 채팅 세션의 usage 와 따로 센다
  const [teamUsage, setTeamUsage] = useState<TeamUsage>(EMPTY_TEAM_USAGE)
  const teamUsageLast = useRef<Record<string, { numTurns: number; cost: number }>>({})
  // 권한 요청은 여러 작업에서 동시에 올 수 있어 큐로 둔다. 맨 앞 것을 보여준다
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const permission = permissions[0] ?? null
  const permissionsRef = useRef(permissions)
  permissionsRef.current = permissions
  const [mode, setMode] = useState<'chat' | 'team'>(() =>
    localStorage.getItem('claude-cli-studio.mode') === 'team' ? 'team' : 'chat'
  )
  useEffect(() => localStorage.setItem('claude-cli-studio.mode', mode), [mode])
  // 채팅 입력을 팀장이 받아 직원에게 배분할지
  const [teamChat, setTeamChat] = useState(() => localStorage.getItem('claude-cli-studio.teamChat') === '1')
  /** 조율 직원의 작업이 끝났을 때 맡기기·돌려보내기를 실행한다 (이벤트 처리기에서 부르므로 ref 로 최신 함수를 가리킨다) */
  const coordinateRef = useRef<(taskId: string, cmd: Coordination, round: number) => void>(() => undefined)
  /** 작업이 더 맡기지 않고 끝났을 때: 그 작업이 보고받은 하위 작업을 승인 처리한다 */
  const finalizeRef = useRef<(taskId: string) => void>(() => undefined)
  // 팀 한도 (이 PC 의 설정): 동시 작업 수, 요청당 작업 수, 요청당 사용량
  const [limits, setLimits] = useState<TeamLimits>(() => {
    try {
      return { ...DEFAULT_TEAM_LIMITS, ...(JSON.parse(localStorage.getItem('claude-cli-studio.teamLimits') ?? '{}') as Partial<TeamLimits>) }
    } catch {
      return DEFAULT_TEAM_LIMITS
    }
  })
  useEffect(() => localStorage.setItem('claude-cli-studio.teamLimits', JSON.stringify(limits)), [limits])
  const limitsRef = useRef(limits)
  limitsRef.current = limits
  /** 동시 작업 수를 넘어 차례를 기다리는 작업 (자리가 나면 넣은 순서대로 시작한다) */
  const queueRef = useRef<{ id: string; followUp?: string; opts: { stay?: boolean; employee?: Employee; resume?: boolean; note?: string }; at: number }[]>([])
  /**
   * 방금 시작해서 아직 목록에 "작업 중"으로 반영되지 않은 작업 → 시작한 시각.
   * 같은 순간에 여러 작업을 시작할 때 수를 맞추려는 것이라 아주 잠깐만 유효하다
   */
  const startingRef = useRef(new Map<string, number>())
  /** 대기 중인 작업이 있는 동안 대기열을 다시 확인하게 하는 값 */
  const [queueTick, setQueueTick] = useState(0)
  /** 인계: 끝나는 작업이 이어지는 일을 동료에게 넘긴다 (같은 상위 아래의 작업으로) */
  const handoffRef = useRef<(from: TeamTask, list: DispatchAssignment[]) => void>(() => undefined)
  /** 보고를 돌려주려고 이어서 시작시킨 상위 작업 (같은 작업을 두 번 시작하지 않게) */
  const resumingRef = useRef(new Set<string>())
  useEffect(() => localStorage.setItem('claude-cli-studio.teamChat', teamChat ? '1' : '0'), [teamChat])
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  // 작업별 실시간 트랜스크립트. ref 에 두고 버전 카운터로 다시 그린다 (이벤트 핸들러 클로저 문제 회피)
  const runtimeRef = useRef<Record<string, TaskRuntime>>({})
  const [, setRuntimeVersion] = useState(0)
  // 세션 안에서 따로 도는 작업(백그라운드 셸·서브에이전트). scope 는 'chat' 또는 팀 작업 id
  const [bgTasks, setBgTasks] = useState<Record<string, Record<string, BgTask>>>({})
  const applyBgTask = useCallback((scope: string, id: string, patch: Partial<BgTask>): void => {
    setBgTasks((all) => {
      const prev = all[scope]?.[id]
      // 시작 이벤트를 못 본 작업의 뒤늦은 갱신은 버린다
      if (!prev && !patch.id) return all
      const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined))
      return { ...all, [scope]: { ...(all[scope] ?? {}), [id]: { ...(prev ?? {}), ...defined } as BgTask } }
    })
  }, [])
  const [rightTab, setRightTab] = useState<RightTab>('tools')
  const [selectedTool, setSelectedTool] = useState<string | null>(null)
  const [insertRequest, setInsertRequest] = useState<{ text: string; nonce: number } | null>(null)
  const [attachRequest, setAttachRequest] = useState<{ attachments: Attachment[]; nonce: number } | null>(null)
  // 터미널·브라우저는 한 번 열면 다른 탭으로 가도 살려 둔다 (PTY 화면, 페이지 상태 유지)
  const [openedTabs, setOpenedTabs] = useState<{ terminal: boolean; browser: boolean }>({ terminal: false, browser: false })
  useEffect(() => {
    if (rightTab === 'terminal' || rightTab === 'browser')
      setOpenedTabs((o) => (o[rightTab] ? o : { ...o, [rightTab]: true }))
  }, [rightTab])
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  // claude.ai 로그인 여부·플랜 (요청을 보내기 전에도 표시)
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null)
  const refreshAuth = useCallback(async (): Promise<AuthStatus> => {
    const st = await window.api.authStatus()
    setAuthStatus(st)
    return st
  }, [])
  const [layout, setLayout] = useState<PanelLayout>(loadLayout)
  const [hostname, setHostname] = useState('')
  const [fbUser, setFbUser] = useState<fb.FbUser | null>(null)
  const [savedSessions, setSavedSessions] = useState<SavedSessionMeta[]>([])
  const [sync, setSync] = useState<SyncState>({ kind: 'idle' })
  // 마지막 저장 이후 아직 Firestore 에 저장하지 않은 변경이 있는지
  const dirty = useRef(false)
  // Firestore 문서 id. Claude 세션 id 와 별개로 앱이 만든다 (팀에게 맡기기만 한 대화도 저장되도록)
  const docId = useRef<string | null>(null)
  // 저장된 세션을 불러온 직후의 items 변경은 "변경"으로 치지 않는다
  const skipDirtyOnce = useRef(false)
  // 세션을 처음 저장한 시각 (문서의 createdAt 유지용)
  const createdAt = useRef<number | null>(null)
  // Firestore 에서 불러온(복원한) 세션인지 — 이 PC 에서 이어가지 못할 수 있다
  const restored = useRef(false)

  // 스트리밍 중인 어시스턴트 텍스트 항목의 id
  const streamingId = useRef<string | null>(null)

  useEffect(() => {
    // 마지막으로 쓰던 작업 폴더로 시작한다. 그 폴더가 없어졌으면 앱이 실행된 위치로
    void (async () => {
      const last = localStorage.getItem(CWD_KEY)
      setCwd(last && (await window.api.isDir(last)) ? last : await window.api.defaultCwd())
    })()
    window.api.getConfig().then(setConfig)
    window.api.getUpdateStatus().then(setUpdateStatus)
    window.api.hostname().then(setHostname)
    void refreshAuth()
    return window.api.onUpdateStatus(setUpdateStatus)
  }, [refreshAuth])

  // 작업 폴더가 바뀔 때마다 기억해 둔다 (폴더 선택, 저장된 세션 열기 모두)
  useEffect(() => {
    if (cwd) localStorage.setItem(CWD_KEY, cwd)
  }, [cwd])

  // ----- 패널 레이아웃 (너비·표시) -----
  useEffect(() => saveLayout(layout), [layout])
  const toggleSidebar = useCallback(() => setLayout((l) => ({ ...l, sidebarOpen: !l.sidebarOpen })), [])
  const toggleRight = useCallback(() => setLayout((l) => ({ ...l, rightOpen: !l.rightOpen })), [])
  const openRight = useCallback(() => setLayout((l) => (l.rightOpen ? l : { ...l, rightOpen: true })), [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return
      if (e.key.toLowerCase() === 'b' && !e.shiftKey) {
        e.preventDefault()
        toggleSidebar()
      } else if (e.key.toLowerCase() === 'j' && !e.shiftKey) {
        e.preventDefault()
        toggleRight()
      } else if (e.key.toLowerCase() === 'k' && !e.shiftKey) {
        e.preventDefault()
        setSearchOpen((o) => !o)
      } else if (e.key === '`') {
        // Ctrl+` : 터미널 탭 열기
        e.preventDefault()
        setLayout((l) => (l.rightOpen ? l : { ...l, rightOpen: true }))
        setRightTab('terminal')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar, toggleRight])
  const resizeSidebar = (dx: number): void =>
    setLayout((l) => ({
      ...l,
      sidebarWidth: clamp(l.sidebarWidth + dx, LIMITS.sidebar.min, maxSidebarWidth(l, window.innerWidth))
    }))
  const resizeRight = (dx: number): void =>
    setLayout((l) => ({
      ...l,
      rightWidth: clamp(l.rightWidth - dx, LIMITS.right.min, maxRightWidth(l, window.innerWidth))
    }))
  const gridColumns = `${layout.sidebarOpen ? layout.sidebarWidth : 0}px minmax(0, 1fr) ${layout.rightOpen ? layout.rightWidth : 0}px`

  // ----- Firebase 연결 / 로그인 상태 -----
  const fbSettings = config?.firebase
  const fbKey = JSON.stringify(fbSettings ?? null)
  useEffect(() => {
    let offAuth: (() => void) | undefined
    let cancelled = false
    if (fbSettings?.enabled && fbSettings.config) {
      fb.ensureFirebase(fbSettings).then((ok) => {
        if (cancelled) return
        if (ok) offAuth = fb.onAuth(setFbUser)
        else setFbUser(null)
      })
    } else {
      fb.ensureFirebase({ enabled: false, saveSessions: false }).then(() => setFbUser(null))
    }
    return () => {
      cancelled = true
      offAuth?.()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fbKey])

  // 로그인되면 세션 목록 구독
  useEffect(() => {
    if (!fbUser || !fbSettings?.enabled) {
      setSavedSessions([])
      return
    }
    return fb.subscribeSessions(fbUser.uid, setSavedSessions, (e) =>
      setSync({ kind: 'error', message: e.message })
    )
  }, [fbUser, fbSettings?.enabled])

  // ----- 메모리 ("기억해" 로 저장한 내용 → 세션 시스템 프롬프트) -----
  const memory = useMemoryStore(fbUser, !!fbSettings?.enabled)
  const memoryText = useMemo(() => renderMemory(memory.memories, cwd), [memory.memories, cwd])
  const memoryCount = useMemo(() => activeMemories(memory.memories, cwd).length, [memory.memories, cwd])
  // 💾 버튼으로 여는 저장 대화상자
  const [rememberDraft, setRememberDraft] = useState<{ text: string; source: MemoryItem['source'] } | null>(null)
  // 대화·보고서 검색 (Ctrl+K)
  const [searchOpen, setSearchOpen] = useState(false)
  const currentTitle = items.find((i) => i.type === 'user')?.text.slice(0, 60) ?? '현재 대화'

  // ----- 팀 (직원 에이전트) -----
  // 팀은 세션마다 따로 꾸린다. store 는 모든 팀의 직원·작업(id 로 찾고 고칠 때), team 은 지금 세션의 팀만 보는 뷰
  const store = useTeamStore(fbUser, !!fbSettings?.enabled)
  // 앱을 켜면 새 세션이므로 새 팀으로 시작한다 (팀은 직원이나 작업이 처음 생길 때 저장된다).
  // 이전 팀은 팀 화면의 선택 상자나 세션 기록에서 다시 고를 수 있다
  const [teamId, setTeamId] = useState(() => crypto.randomUUID() as string)
  const scoped = useScopedTeam(store, teamId)
  const team = {
    ...store,
    employees: scoped.employees,
    tasks: scoped.tasks,
    // 새 직원·작업은 지금 팀에 들어가고, 이미 있는 것은 속한 팀을 그대로 둔다
    upsertEmployee: scoped.upsertEmployee,
    upsertTask: scoped.upsertTask
  }
  const patchTaskRef = useRef(store.patchTask)
  patchTaskRef.current = store.patchTask
  const teamRef = useRef(store)
  teamRef.current = store
  const scopedRef = useRef(scoped)
  scopedRef.current = scoped

  // 팀 이름은 세션의 첫 메시지를 따라간다 (직접 정한 이름이 없을 때)
  useEffect(() => {
    const info = store.teams.find((t) => t.id === teamId)
    const firstUser = items.find((i) => i.type === 'user')
    const full = firstUser && firstUser.type === 'user' ? firstUser.text.trim().replace(/\s+/g, ' ') : ''
    const title = full.length > 30 ? full.slice(0, 30).trim() + '…' : full
    if (info?.autoName && title && info.name !== title) store.upsertTeam({ ...info, name: title })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.teams, teamId, items])

  // 작업 이벤트 → 런타임 + 작업 레코드
  useEffect(() => {
    return window.api.onTeamEvent(({ taskId, event, afterStop }) => {
      // 플랜 한도는 계정 전체 값이라 직원·팀장 세션에서 온 것도 그대로 반영한다
      if (event.kind === 'rate_limit') {
        setPlan({ windows: event.windows, isUsingOverage: event.isUsingOverage, updatedAt: event.updatedAt })
      }
      if (event.kind === 'result') {
        // 턴 수·비용은 세션을 이어갈 때(수정 요청·답변) 누적값으로 오므로 작업별 직전 값과의 차이만 더한다
        const u = event.usage
        const last = teamUsageLast.current[taskId] ?? { numTurns: 0, cost: 0 }
        const dTurns = u.numTurns >= last.numTurns ? u.numTurns - last.numTurns : u.numTurns
        const dCost = u.totalCostUsd >= last.cost ? u.totalCostUsd - last.cost : u.totalCostUsd
        // 팀장 배분은 매번 새 세션이라 직전 값을 남기지 않는다
        if (taskId !== DISPATCH_TASK_ID) teamUsageLast.current[taskId] = { numTurns: u.numTurns, cost: u.totalCostUsd }
        setTeamUsage((t) => ({
          runs: t.runs + 1,
          numTurns: t.numTurns + dTurns,
          inputTokens: t.inputTokens + u.inputTokens,
          outputTokens: t.outputTokens + u.outputTokens,
          cacheReadTokens: t.cacheReadTokens + u.cacheReadTokens,
          cacheCreationTokens: t.cacheCreationTokens + u.cacheCreationTokens,
          durationMs: t.durationMs + u.durationMs,
          totalCostUsd: t.totalCostUsd + dCost
        }))
      }
      // 팀장 세션은 사용량만 집계하고 작업 목록에는 넣지 않는다
      if (taskId === DISPATCH_TASK_ID) return
      if (event.kind === 'bg_task') {
        applyBgTask(taskId, event.id, event.patch)
        return
      }
      // 중단을 누른 뒤에 도착한 종료 이벤트는 작업 상태를 바꾸지 않는다 (이미 "중단됨"이거나, 곧바로 이어서 시작했을 수 있다)
      if (afterStop && (event.kind === 'result' || event.kind === 'error')) return
      const prev = runtimeRef.current[taskId] ?? EMPTY_RUNTIME
      const next = applyEvent(prev, event)
      runtimeRef.current = { ...runtimeRef.current, [taskId]: next }
      setRuntimeVersion((v) => v + 1)
      if (event.kind !== 'result' && event.kind !== 'error') {
        patchTaskRef.current(taskId, (t) => deriveTaskPatch(t, event, next) ?? {})
        return
      }
      // 작업이 끝났다. 누가 검토할지에 따라 다음 상태가 갈린다:
      //  - 다른 직원에게 일을 맡겼으면 "팀 대기" (보고가 돌아오면 이어서 진행)
      //  - 직원이 맡긴 작업이면 "내부 검토" (사용자가 아니라 맡긴 직원이 검토)
      //  - 사용자가 직접 맡긴 작업이면 "검토 요청"
      const t = teamRef.current.tasks.find((x) => x.id === taskId)
      const e = t && teamRef.current.employees.find((x) => x.id === t.employeeId)
      const failed = event.kind === 'error' || event.isError
      // 맡긴 직원의 작업이 아직 살아 있을 때만 그 직원이 검토한다. 이미 끝났거나 지워졌으면 사용자가 검토한다
      const leadTask = t ? teamRef.current.tasks.find((x) => x.id === parentOf(t)) : undefined
      const hasLead = !!leadTask && (leadTask.status === 'waiting_team' || isActive(leadTask.status))
      let wait = false
      let blocked = ''
      if (!failed && t && e && t.status !== 'stopped') {
        const cmd = parseCoordination(next.lastAssistantText)
        // 문의에 답하는 작업은 답만 하고 끝난다 (더 맡기거나 묻거나 넘기지 않는다)
        const leaf = isAsk(t)
        const canCoordinate = !leaf && isTeamAware(e) && depthOf(t, teamRef.current.tasks) < MAX_DEPTH
        if (!canCoordinate) {
          cmd.delegate = []
          cmd.revise = []
        }
        if (leaf) {
          cmd.ask = []
          cmd.handoff = []
        }
        // 한도: 이 요청이 작업 수나 사용량 한도에 닿았으면 더 맡기거나 묻거나 넘기지 않고 여기서 마무리한다
        const over = limitReached(t, teamRef.current.tasks, limitsRef.current, (x) =>
          x.id === t.id && event.kind === 'result' ? event.usage.totalCostUsd : (x.progress.costUsd ?? 0)
        )
        if (over && cmd.delegate.length + cmd.revise.length + cmd.ask.length + cmd.handoff.length > 0) {
          cmd.delegate = []
          cmd.revise = []
          cmd.ask = []
          cmd.handoff = []
          blocked = `${over}에 도달해, 이 보고에 적힌 맡기기·문의·인계는 실행되지 않았습니다.`
          const root = rootOf(t, teamRef.current.tasks)
          teamRef.current.patchTask(root.id, { limitNote: `${over}에 도달해 더 맡기지 않고 마무리했습니다. 이어서 하려면 이 작업에 답변이나 수정 요청으로 "계속 진행"이라고 보내세요.` })
        }
        // 결정: 팀 결정 기록에 남겨 모든 직원에게 전달한다
        if (cmd.decisions.length > 0) teamRef.current.addDecisions(teamOf(t), e.name, cmd.decisions)
        // 인계: 상위가 보고를 기다리고 있을 때만. 이 작업을 끝난 것으로 표시하기 전에 넘겨서, 상위가 넘긴 작업까지 기다리게 한다
        if (cmd.handoff.length > 0 && leadTask?.status === 'waiting_team' && !canCoordinate) handoffRef.current(t, cmd.handoff)
        const round = (t.delegation?.round ?? 0) + 1
        const cap = canCoordinate ? MAX_AUTO_ROUNDS : MAX_PEER_ROUNDS
        if ((cmd.delegate.length > 0 || cmd.revise.length > 0 || cmd.ask.length > 0) && round <= cap) {
          wait = true
          setTimeout(() => coordinateRef.current(taskId, cmd, round), 0)
        } else setTimeout(() => finalizeRef.current(taskId), 0)
      }
      // 알림은 사용자가 봐야 하는 것만: 사용자가 직접 맡긴 작업이 끝났거나 실패했을 때
      if (t && !hasLead && !wait) {
        window.api.notify(failed ? '작업 실패' : '작업 완료 · 검토 요청', `${e ? `${e.emoji} ${e.name} · ` : ''}${t.title}`)
      }
      const doneStatus = wait ? 'waiting_team' : hasLead ? 'internal_review' : 'needs_review'
      patchTaskRef.current(taskId, (cur) => {
        const patch = deriveTaskPatch(cur, event, next) ?? {}
        if (patch.status !== 'needs_review') return patch
        if (wait) return { ...patch, status: doneStatus }
        // 한도 때문에 실행하지 않은 것이 있으면 보고서 끝에 적어, 보고를 받는 쪽이 오해하지 않게 한다
        const report = blocked && patch.report ? `${patch.report}\n\n> (앱 알림) ${blocked}` : patch.report
        return { ...patch, report, status: doneStatus, delegation: undefined }
      })
    })
  }, [applyBgTask])

  // 대기 중인 권한 요청이 있는 팀 작업은 "승인 필요" 로 표시
  useEffect(() => {
    const waiting = new Set(permissions.map((p) => p.taskId).filter((id): id is string => !!id))
    for (const t of store.tasks) {
      if (waiting.has(t.id) && isActive(t.status) && t.status !== 'waiting_permission') {
        teamRef.current.upsertTask({ ...t, status: 'waiting_permission' })
      }
    }
  }, [permissions, store.tasks])

  /**
   * 팝업 대기열을 메인 프로세스가 실제로 기다리는 요청 목록에 맞춘다. 대기열은 화면 쪽 메모리에만 있어서
   * 화면이 다시 로드되면 사라지는데, 그러면 작업은 답을 기다리며 멈춰 있고 팝업은 보이지 않게 된다.
   */
  const syncPermissions = useCallback(async (): Promise<void> => {
    const before = new Set(permissionsRef.current.map((p) => p.requestId))
    const [pending, runningIds] = await Promise.all([window.api.pendingPermissions(), window.api.teamRunning()])
    const alive = new Set(pending.map((p) => p.requestId))
    setPermissions((q) => {
      // 확인하는 사이에 새로 들어온 요청(before 에 없던 것)은 그대로 둔다
      const kept = q.filter((p) => alive.has(p.requestId) || !before.has(p.requestId))
      const have = new Set(kept.map((p) => p.requestId))
      return [...kept, ...pending.filter((p) => !have.has(p.requestId))]
    })
    // 이 앱에서 돌고 있는데 기다리는 요청이 없으면 "승인 필요" 표시를 푼다
    const waiting = new Set(pending.map((p) => p.taskId))
    for (const t of teamRef.current.tasks) {
      if (t.status === 'waiting_permission' && runningIds.includes(t.id) && !waiting.has(t.id)) {
        teamRef.current.upsertTask({ ...t, status: 'running' })
      }
    }
  }, [])

  // 화면이 (다시) 로드되면 기다리던 권한 요청을 되살린다
  useEffect(() => {
    void syncPermissions()
  }, [syncPermissions])

  // 앱을 다시 켰을 때 "작업 중"으로 남아 있는 작업은 실제로는 죽었으므로 중단 처리
  const reconciled = useRef(false)
  useEffect(() => {
    if (reconciled.current || store.tasks.length === 0) return
    reconciled.current = true
    Promise.all([window.api.teamRunning(), window.api.hostname()]).then(([ids, host]) => {
      for (const t of teamRef.current.tasks) {
        // 대기열은 앱을 끄면 사라진다. 차례를 기다리던 작업은 중단으로 두어 "이어서 진행"으로 다시 시작할 수 있게 한다
        if (t.status === 'queued' && !queueRef.current.some((q) => q.id === t.id) && (!t.runHost || t.runHost === host)) {
          teamRef.current.patchTask(t.id, { status: 'stopped', finishedAt: Date.now(), error: '앱이 종료되어 차례를 기다리던 작업이 시작되지 못했습니다. "이어서 진행"으로 다시 시작할 수 있습니다.' })
          continue
        }
        if (!isActive(t.status) || ids.includes(t.id)) continue
        // 다른 PC 에서 실행한 작업은 그 PC 에서 아직 돌고 있을 수 있으므로 건드리지 않는다
        if (t.runHost && t.runHost !== host) continue
        teamRef.current.upsertTask({ ...t, status: 'stopped', finishedAt: Date.now(), error: t.error ?? '앱이 종료되어 작업이 중단되었습니다. "처음부터 다시 실행"으로 다시 맡길 수 있습니다.' })
      }
      // 작업 목록이 늦게 도착했을 수 있으므로 "승인 필요" 표시도 한 번 더 맞춘다
      void syncPermissions()
    })
  }, [store.tasks.length, syncPermissions])

  /**
   * 작업 시작. opts.stay 면 팀 화면으로 전환하지 않고(채팅에서 배분한 작업), opts.employee 로
   * 방금 채용해 아직 team.employees 에 반영되지 않은 직원을 넘길 수 있다.
   */
  /** 이 PC 에서 지금 실행 중인 직원 작업 수 (방금 시작해 아직 목록에 반영되지 않은 것 포함) */
  const activeHere = (): number => {
    const active = teamRef.current.tasks.filter((t) => isActive(t.status) && (!t.runHost || !hostname || t.runHost === hostname))
    const now = Date.now()
    let pending = 0
    for (const [id, at] of startingRef.current) {
      // 목록에 반영됐거나 잠깐이 지났으면 표식을 지운다 (오래 두면 이미 끝난 작업을 실행 중으로 세게 된다)
      if (active.some((t) => t.id === id) || now - at > 1500) startingRef.current.delete(id)
      else pending++
    }
    return active.length + pending
  }

  const startTask = (
    task: TeamTask,
    followUp?: string,
    opts: { stay?: boolean; employee?: Employee; resume?: boolean; note?: string; fromQueue?: boolean } = {}
  ): void => {
    const employee = opts.employee ?? store.employees.find((e) => e.id === task.employeeId)
    if (!employee) return
    // 동시에 실행하는 작업 수를 넘으면 대기시킨다. 자리가 나면 넣은 순서대로 시작한다
    if (!opts.fromQueue && activeHere() >= limitsRef.current.maxParallel) {
      queueRef.current.push({ id: task.id, followUp, opts, at: Date.now() })
      team.upsertTask({ ...task, status: 'queued', finishedAt: undefined, error: undefined, approvedBy: undefined })
      if (!opts.stay) setMode('team')
      return
    }
    startingRef.current.set(task.id, Date.now())
    const started: TeamTask = {
      ...task,
      // 중단됐던 작업을 이어 가는 것은 수정 요청이 아니므로 "작업 중"으로 표시한다
      status: followUp && !opts.resume ? 'changes_requested' : 'running',
      startedAt: followUp ? task.startedAt ?? Date.now() : Date.now(),
      finishedAt: undefined,
      error: undefined,
      approvedBy: undefined,
      sessionId: followUp ? task.sessionId : undefined,
      progress: followUp ? { ...task.progress, lastTool: undefined } : { toolUses: 0 },
      runHost: hostname || task.runHost
    }
    team.upsertTask(started)
    const prevRt = followUp ? runtimeRef.current[task.id] ?? EMPTY_RUNTIME : EMPTY_RUNTIME
    const userText = opts.note ?? (opts.resume ? '▶ 중단된 작업을 이어서 진행' : (followUp ?? `# ${task.title}\n\n${task.instructions}`))
    // 이 작업이 속한 팀 (새 작업이면 지금 세션의 팀)
    const tid = task.teamId ?? (store.tasks.some((x) => x.id === task.id) ? DEFAULT_TEAM_ID : teamId)
    const mates = store.employees.filter((e) => teamOf(e) === tid)
    // 이 작업을 맡긴 직원 (없으면 사용자가 직접 맡긴 작업). 보고와 질문은 그 직원에게 간다
    const leadTask = store.tasks.find((x) => x.id === parentOf(task))
    const leadEmp = leadTask && store.employees.find((e) => e.id === leadTask.employeeId)
    // 조율 역할이고 맡기기 깊이가 남아 있으면 다른 직원에게 일을 맡길 수 있다. 위쪽(맡긴 사람들)은 목록에서 뺀다
    const ask = isAsk(task)
    const aware = !ask && isTeamAware(employee) && depthOf(task, store.tasks) < MAX_DEPTH
    const leadAlive = !!leadTask && (leadTask.status === 'waiting_team' || isActive(leadTask.status))
    const upline = new Set<string>()
    for (let cur = leadTask; cur && !upline.has(cur.employeeId); cur = store.tasks.find((x) => x.id === parentOf(cur!))) upline.add(cur.employeeId)
    runtimeRef.current = {
      ...runtimeRef.current,
      [task.id]: { ...prevRt, streamingId: null, items: [...prevRt.items, { id: `u-${Date.now()}`, type: 'user', text: userText }] }
    }
    setRuntimeVersion((v) => v + 1)
    if (!opts.stay) setMode('team')
    window.api
      .teamStart({
        task: started,
        employee,
        followUp,
        memory: memoryText,
        // 조율하는 직원(PM·기획자)에게는 지금 팀이 하고 있는 일과 같은 팀 직원 목록을 함께 알려 준다
        teamStatus: aware ? renderTeamStatus(mates, store.tasks.filter((t) => teamOf(t) === tid), Date.now(), task.id) : undefined,
        roster: aware ? renderRoster(mates.filter((m) => !upline.has(m.id)), employee.id) : undefined,
        lead: leadEmp ? { name: leadEmp.name, role: leadEmp.role, ask: ask || undefined } : undefined,
        // 동료에게 직접 묻거나(문의) 이어지는 일을 넘길 수 있다(인계). 문의에 답하는 작업은 답만 한다
        peers: ask ? undefined : renderRoster(mates.filter((m) => !upline.has(m.id)), employee.id),
        canHandoff: !ask && !aware && leadAlive,
        // 팀에서 이미 정한 것 (다시 묻지 않게)
        decisions: renderDecisions(store.teams.find((x) => x.id === tid)?.decisions) || undefined
      })
      .catch((err) => {
        patchTaskRef.current(task.id, { status: 'failed', finishedAt: Date.now(), error: err instanceof Error ? err.message : String(err) })
      })
  }

  const stopTask = (id: string): void => {
    void window.api.teamStop(id)
    patchTaskRef.current(id, { status: 'stopped', finishedAt: Date.now() })
  }
  /** 중단된 작업을 이어서 진행. 세션이 남아 있으면 그 세션에서, 없으면(시작 직후 중단) 처음부터 */
  const resumeTask = (t: TeamTask, opts: { stay?: boolean } = {}): void => {
    if (t.sessionId) startTask(t, RESUME_PROMPT, { resume: true, stay: opts.stay })
    else startTask({ ...t, sessionId: undefined }, undefined, { stay: opts.stay })
  }
  /** 요청 하나(이 작업과 그 아래 전부)를 모두 중단한다: 실행 중·대기 중·보고를 기다리는 작업 모두 */
  const stopTree = (rootId: string): void => {
    for (const t of subtreeOf(rootId, store.tasks)) {
      if (isActive(t.status) || t.status === 'waiting_team' || t.status === 'queued') stopTask(t.id)
    }
  }
  /** 직원 한 명의 진행 중인 작업을 모두 중단 */
  const stopEmployee = (employeeId: string): void => {
    for (const t of team.tasks) if (t.employeeId === employeeId && isActive(t.status)) stopTask(t.id)
  }
  /** 직원 한 명의 중단된 작업을 모두 이어서 진행 */
  const resumeEmployee = (employeeId: string): void => {
    for (const t of team.tasks) if (t.employeeId === employeeId && t.status === 'stopped') resumeTask(t, { stay: true })
  }

  /** 팀 화면에서 다른 팀으로 바꾼다. 이 세션이 그 팀을 쓰게 된다 */
  const switchTeam = (id: string): void => {
    if (id === teamId) return
    setTeamId(id)
    setSelectedTaskId(null)
    setSelectedTool(null)
    dirty.current = true
  }
  /** 작업을 팀 화면에서 연다. 다른 팀의 작업이면 그 팀으로 바꾼다 */
  const openTask = (id: string): void => {
    const t = store.tasks.find((x) => x.id === id)
    if (t) switchTeam(teamOf(t))
    setSelectedTaskId(id)
    setSelectedTool(null)
    setMode('team')
  }
  /** 팀과 그 팀의 직원·작업을 지운다. 진행 중인 작업이 있으면 지우지 않는다 */
  const deleteTeam = (id: string): boolean => {
    const mine = store.tasks.filter((t) => teamOf(t) === id)
    if (mine.some((t) => isActive(t.status))) return false
    const drop = new Set(mine.map((t) => t.id))
    runtimeRef.current = Object.fromEntries(Object.entries(runtimeRef.current).filter(([k]) => !drop.has(k)))
    setBgTasks((all) => Object.fromEntries(Object.entries(all).filter(([k]) => !drop.has(k))))
    store.removeTeam(id)
    if (id === teamId) {
      setTeamId(crypto.randomUUID())
      setSelectedTaskId(null)
    }
    return true
  }

  const reviewTask = (id: string, decision: ReviewDecision, comment: string): void => {
    const t = store.tasks.find((x) => x.id === id)
    if (!t) return
    const reviews = [...t.reviews, { at: Date.now(), decision, comment: comment || undefined }]
    if (decision === 'approved') {
      team.upsertTask({ ...t, status: 'approved', reviews })
      return
    }
    const round = t.round + 1
    // 사용자가 답한 것은 팀 결정 기록에 남겨, 다른 직원이 같은 것을 다시 묻지 않게 한다
    if (decision === 'answered' && comment.trim()) {
      const one = (x: string, n: number): string => {
        const y = x.replace(/\s+/g, ' ').trim()
        return y.length > n ? y.slice(0, n) + '…' : y
      }
      const pairs = [...comment.matchAll(/\d+\.\s*확인 요청:\s*([\s\S]*?)\n\s*답변:\s*([\s\S]*?)(?=\n\s*\n|$)/g)].map((m) => `${one(m[1], 160)} → ${one(m[2], 120)}`)
      store.addDecisions(teamOf(t), '사용자', pairs.length > 0 ? pairs : [one(comment, 280)])
    }
    const followUp =
      decision === 'answered'
        ? // 보고서의 확인 요청(질문)에 대한 답. 수정 지시가 아니라 판단 근거를 주는 것이다
          `# 확인 요청에 대한 답변\n\n${comment}\n\n` +
          `위 답변을 기준으로 이전 작업을 이어서 진행하세요. 답변 때문에 더 바꿀 것이 없다면 파일을 건드리지 말고 그 사실만 보고하세요. ` +
          `끝나면 다시 "## 보고" 형식으로 보고하세요.`
        : `# 수정 요청 (${round}차)\n\n${comment}\n\n` +
          `이전 작업을 이어서 반영하세요. 끝나면 다시 "## 보고" 형식으로 보고하세요.`
    // 채팅에서 배분된 작업은 채팅에 머문다
    // 사용자가 다시 지시한 것이므로 맡기기 횟수와 한도는 지금부터 다시 센다
    const root = rootOf(t, store.tasks)
    const stats = treeStats(subtreeOf(root.id, store.tasks))
    const limitBase = { cost: stats.cost, tasks: stats.tasks }
    if (root.id !== t.id) store.patchTask(root.id, { limitBase, limitNote: undefined })
    startTask(
      { ...t, reviews, round, delegation: undefined, ...(root.id === t.id ? { limitBase, limitNote: undefined } : {}) },
      followUp,
      { stay: t.origin?.kind === 'chat' }
    )
  }

  // ----- 채팅 요청 → 팀장 배분 -----

  /** 템플릿 직함으로 그 팀의 직원을 찾거나 새로 채용한다. hired 는 이번 배분에서 방금 만든 직원들 */
  const hireFromPreset = (role: string, hired: Employee[], tid: string = teamId): Employee | undefined => {
    const norm = (x: string): string => x.replace(/\s|\(.*?\)/g, '').toLowerCase()
    const match = (e: { role: string }): boolean => norm(e.role) === norm(role) || norm(e.role).includes(norm(role)) || norm(role).includes(norm(e.role))
    const existing = hired.find(match) ?? teamRef.current.employees.filter((e) => teamOf(e) === tid).find(match)
    if (existing) return existing
    const preset = EMPLOYEE_PRESETS.find(match)
    if (!preset) return undefined
    const now = Date.now()
    const e: Employee = { ...preset, id: crypto.randomUUID(), createdAt: now, updatedAt: now, teamId: tid === DEFAULT_TEAM_ID ? undefined : tid }
    if (tid === teamId) team.upsertEmployee(e)
    else store.upsertEmployee(e)
    hired.push(e)
    return e
  }

  /** 맡길 작업 목록을 그 팀의 직원 작업으로 만들어 시작한다. exclude 는 맡길 수 없는 직원(자기 자신과 위쪽) */
  const startAssignments = (
    list: DispatchAssignment[],
    tid: string,
    taskCwd: string,
    origin: TeamTask['origin'],
    exclude: string[] = []
  ): { taskIds: string[]; skipped: string[] } => {
    const pool = teamRef.current.employees.filter((e) => teamOf(e) === tid && !exclude.includes(e.id))
    const hired: Employee[] = []
    const taskIds: string[] = []
    const skipped: string[] = []
    for (const a of list) {
      const who = a.employeeId
      let employee = who ? pool.find((e) => e.id === who) : undefined
      // 모델이 id 대신 이름이나 직함을 적는 경우도 받아 준다
      if (!employee && who) employee = pool.find((e) => e.name === who || e.role === who)
      if (!employee && a.presetRole) employee = hireFromPreset(a.presetRole, hired, tid)
      if (!employee && who) employee = hireFromPreset(who, hired, tid)
      if (!employee || exclude.includes(employee.id)) {
        skipped.push(a.title)
        continue
      }
      const task: TeamTask = {
        id: crypto.randomUUID(),
        teamId: tid === DEFAULT_TEAM_ID ? undefined : tid,
        employeeId: employee.id,
        title: a.title,
        instructions: a.instructions,
        cwd: taskCwd,
        status: 'queued',
        createdAt: Date.now(),
        progress: { toolUses: 0 },
        reviews: [],
        round: 0,
        origin
      }
      // 지금 세션의 팀이 아닌 팀의 작업은 먼저 넣어 두어 팀이 바뀌지 않게 한다
      if (tid !== teamId) store.upsertTask(task)
      taskIds.push(task.id)
      startTask(task, undefined, { stay: true, employee })
    }
    return { taskIds, skipped }
  }

  /** 이 팀의 PM (사용자와 팀 사이의 창구). 없으면 템플릿에서 채용한다 */
  const findOrHirePm = (): Employee | undefined =>
    team.employees.find((e) => /PM|프로덕트 매니저|product manager/i.test(e.role)) ??
    team.employees.find((e) => e.teamAware === true) ??
    hireFromPreset('프로덕트 매니저 (PM)', [])

  /**
   * 채팅의 "팀에게 맡기기": 요청은 PM 이 받는다. PM 이 팀에 일을 맡기고, 보고를 받아 검토하고,
   * 정리된 결과와 사용자만 정할 수 있는 질문만 이 채팅으로 돌려준다.
   */
  const dispatchToTeam = async (rawPrompt: string, attachments: Attachment[] = []): Promise<void> => {
    setItems((prev) => [...prev, { id: `u-${Date.now()}`, type: 'user', text: rawPrompt, attachments: attachments.length ? attachments : undefined }])
    const pm = findOrHirePm()
    if (!pm) {
      setItems((prev) => [...prev, { id: `e-${Date.now()}`, type: 'system', text: '요청을 받을 PM 을 만들지 못했습니다. 팀 화면에서 PM 직원을 추가해 주세요.', isError: true }])
      return
    }
    const oneLine = rawPrompt.trim().replace(/\s+/g, ' ')
    const task: TeamTask = {
      id: crypto.randomUUID(),
      employeeId: pm.id,
      title: oneLine.length > 30 ? oneLine.slice(0, 30).trim() + '…' : oneLine || '요청',
      instructions: withAttachments(rawPrompt, attachments),
      cwd,
      status: 'queued',
      createdAt: Date.now(),
      progress: { toolUses: 0 },
      reviews: [],
      round: 0,
      origin: { kind: 'chat', requestId: `req-${Date.now()}` }
    }
    startTask(task, undefined, { stay: true, employee: pm })
    setItems((prev) => [
      ...prev,
      {
        id: `d-${Date.now()}`,
        type: 'dispatch',
        summary: `${pm.name}(PM)이 요청을 받았습니다. 팀에 맡기고 결과를 검토한 뒤, 정리된 보고만 여기로 돌려줍니다.`,
        taskIds: [task.id]
      }
    ])
  }

  /** 기다리던 작업에게 돌려줄 글: 문의의 답, 맡긴 작업들의 보고와 검토 방법 */
  const leadFollowUp = (parent: TeamTask, round: number, done: TeamTask[]): string => {
    const answers = done.filter(isAsk)
    const reports = done.filter((t) => !isAsk(t))
    const emp = store.employees.find((e) => e.id === parent.employeeId)
    const coordinator = !!emp && isTeamAware(emp) && depthOf(parent, store.tasks) < MAX_DEPTH
    const over = limitReached(parent, store.tasks, limits)
    const last = round >= (coordinator ? MAX_AUTO_ROUNDS : MAX_PEER_ROUNDS) || !!over
    const overText = over ? `(앱 알림) ${over}에 도달했습니다. 이 요청에서는 더 맡기거나 묻거나 넘길 수 없습니다.\n\n` : ''
    const answerText = answers.length ? `# 문의에 대한 답\n\n${renderReports(answers, store.employees)}\n\n` : ''
    // 문의만 했던 경우: 답을 받아 원래 작업을 이어 간다
    if (reports.length === 0 && answers.length > 0) {
      return (
        answerText +
        overText +
        '위 답을 바탕으로 원래 작업을 이어서 진행하세요. ' +
        (last ? '문의는 여기까지입니다. 더 묻지 말고, 남은 의문은 가장 무난한 쪽으로 정해 진행한 뒤 보고서에 적으세요. ' : '') +
        '끝나면 "## 보고" 형식으로 보고하세요.'
      )
    }
    return (
      answerText +
      overText +
      `# 맡긴 작업의 보고 (${round}차)\n\n${reports.length ? renderReports(reports, store.employees) : '(돌아온 보고가 없습니다)'}\n\n` +
      '## 할 일\n' +
      '1. 각 결과가 지시와 완료 기준을 충족하는지 확인하세요. 보고만 믿지 말고 필요하면 파일을 열어 봅니다.\n' +
      '2. 직원의 "상위 확인 요청"에는 당신이 정해서 답하세요. 답 때문에 작업이 달라지면 revise 로 돌려보내고, 아니면 정한 내용을 다음 지시나 보고에 반영합니다. 다른 직원도 따라야 하는 결정은 decisions 에 적어 두세요.\n' +
      (last
        ? '3. 맡기기는 여기까지입니다. 더 맡기거나 돌려보내지 말고 지금까지의 결과로 최종 보고를 하세요. 남은 일은 보고서에 적습니다.\n'
        : '3. 미흡한 작업은 revise 로 돌려보내고, 다음 단계가 남았으면 delegate 로 맡기세요. 둘 다 없으면 블록 없이 최종 보고를 합니다 (보고받은 작업은 승인 처리됩니다).\n') +
      '4. 위로 올릴 질문은 당신도 정할 수 없는 것만, 여러 직원의 것을 하나로 모아 중복 없이 적으세요.\n' +
      '끝나면 "## 보고" 형식으로 보고하세요.'
    )
  }

  /** 기다리던 작업(맡긴 작업의 보고, 문의의 답)을 모아 그 작업을 이어서 진행시킨다 */
  const collectReports = (parent: TeamTask): void => {
    const kids = (parent.delegation?.taskIds ?? []).map((id) => store.tasks.find((t) => t.id === id)).filter((t): t is TeamTask => !!t && isSettled(t.status))
    const round = parent.delegation?.round ?? 1
    const answers = kids.filter(isAsk).length
    const note =
      answers === kids.length && answers > 0
        ? `💬 문의 ${answers}건의 답을 받아 이어서 진행`
        : `📨 맡긴 작업 ${kids.length - answers}건의 보고${answers ? `와 문의 ${answers}건의 답` : ''}을 받아 검토 (${round}차)`
    resumingRef.current.add(parent.id)
    startTask(parent, leadFollowUp(parent, round, kids), { resume: true, stay: true, note })
  }

  /** 이름이나 직함으로 그 팀의 직원을 찾는다 (새로 채용하지는 않는다) */
  const findMate = (who: string, pool: Employee[]): Employee | undefined => {
    const norm = (x: string): string => x.replace(/\s|\(.*?\)/g, '').toLowerCase()
    return (
      pool.find((e) => e.id === who || e.name === who || e.role === who) ??
      pool.find((e) => norm(e.name) === norm(who) || norm(e.role) === norm(who)) ??
      pool.find((e) => norm(e.role).includes(norm(who)) || norm(who).includes(norm(e.role)))
    )
  }

  // 인계: 끝나는 작업이 이어지는 일을 동료에게 넘긴다. 넘긴 일은 같은 상위 아래의 작업이 되어, 결과가 상위에게 간다
  handoffRef.current = (from, list) => {
    const all = teamRef.current.tasks
    const lead = all.find((t) => t.id === parentOf(from))
    const fromEmp = teamRef.current.employees.find((e) => e.id === from.employeeId)
    if (!lead?.delegation || !fromEmp) return
    const tid = teamOf(from)
    // 자기 자신과 위쪽(상위와 그 위)에게는 넘기지 않는다
    const exclude = [from.employeeId]
    for (let cur: TeamTask | undefined = lead; cur && !exclude.includes(cur.employeeId); cur = all.find((t) => t.id === parentOf(cur!))) exclude.push(cur.employeeId)
    const pool = teamRef.current.employees.filter((e) => teamOf(e) === tid && !exclude.includes(e.id))
    const siblings = all.filter((t) => parentOf(t) === lead.id && t.id !== from.id && !isAsk(t))
    const ids: string[] = []
    const fresh: DispatchAssignment[] = []
    for (const a of list) {
      const target = a.employeeId ? findMate(a.employeeId, pool) : undefined
      // 받는 직원이 같은 상위 아래에서 이미 끝낸 작업이 있으면 그 작업으로 되돌려 보낸다 (결함·지적을 만든 사람에게)
      const back = target && siblings.filter((t) => t.employeeId === target.id && isSettled(t.status)).sort((x, y) => (y.finishedAt ?? 0) - (x.finishedAt ?? 0))[0]
      if (!back) {
        fresh.push(a)
        continue
      }
      // 같은 작업을 너무 여러 번 주고받으면 그만두고 상위가 정리하게 둔다
      if (back.round >= MAX_HANDOFF_BACK || ids.includes(back.id)) continue
      const n = back.round + 1
      const note = `# ${fromEmp.name}(${fromEmp.role})이(가) 넘긴 일 (${n}차)\n\n## ${a.title}\n${a.instructions}`
      if (back.sessionId) startTask({ ...back, round: n }, `${note}\n\n위 내용을 반영해 이어서 진행하고, 끝나면 같은 형식으로 다시 보고하세요.`, { stay: true })
      else startTask({ ...back, round: n, instructions: `${back.instructions}\n\n${note}` }, undefined, { stay: true })
      ids.push(back.id)
    }
    const room = MAX_TEAM_TASKS - all.filter((t) => parentOf(t) === lead.id).length
    ids.push(...startAssignments(fresh.slice(0, Math.max(0, room)), tid, from.cwd, { kind: 'delegate', parentTaskId: lead.id }, exclude).taskIds)
    if (ids.length === 0) return
    // 상위가 기다리는 작업 목록에 더한다 (넘긴 작업까지 끝나야 상위가 보고를 받는다)
    store.patchTask(lead.id, (cur) => (cur.delegation ? { delegation: { ...cur.delegation, taskIds: [...new Set([...cur.delegation.taskIds, ...ids])] } } : {}))
  }

  // 조율 직원의 작업이 끝나면서 낸 맡기기·돌려보내기를 실행한다
  coordinateRef.current = (taskId, cmd, round) => {
    const parent = store.tasks.find((t) => t.id === taskId)
    const emp = parent && store.employees.find((e) => e.id === parent.employeeId)
    if (!parent || !emp) return
    const ids: string[] = []
    const tid = teamOf(parent)
    // 자기 자신과 위쪽(이 작업을 맡긴 사람들)에게는 맡기거나 묻지 않는다
    const exclude = [parent.employeeId]
    for (let cur = store.tasks.find((t) => t.id === parentOf(parent)); cur && !exclude.includes(cur.employeeId); cur = store.tasks.find((t) => t.id === parentOf(cur!))) {
      exclude.push(cur.employeeId)
    }
    // 문의: 동료에게 묻는다. 답이 오면 이 작업이 이어서 진행된다 (문의하려고 새 직원을 채용하지는 않는다)
    const pool = teamRef.current.employees.filter((e) => teamOf(e) === tid && !exclude.includes(e.id))
    for (const q of cmd.ask) {
      const who = findMate(q.employee, pool)
      if (!who) continue
      const one = q.question.replace(/\s+/g, ' ')
      const task: TeamTask = {
        id: crypto.randomUUID(),
        teamId: tid === DEFAULT_TEAM_ID ? undefined : tid,
        employeeId: who.id,
        title: `문의: ${one.length > 26 ? one.slice(0, 26).trim() + '…' : one}`,
        instructions: `${emp.name}(${emp.role})의 문의입니다. ("${parent.title}" 작업 중)\n\n${q.question}`,
        cwd: parent.cwd,
        status: 'queued',
        createdAt: Date.now(),
        progress: { toolUses: 0 },
        reviews: [],
        round: 0,
        origin: { kind: 'ask', parentTaskId: taskId }
      }
      if (tid !== teamId) store.upsertTask(task)
      startTask(task, undefined, { stay: true, employee: who })
      ids.push(task.id)
    }
    // 돌려보내기: 보고받은 작업을 같은 직원에게 (같은 세션에서 이어서)
    const norm = (x: string): string => x.replace(/\s+/g, '').toLowerCase()
    const children = store.tasks.filter((t) => parentOf(t) === taskId && !isAsk(t))
    for (const r of cmd.revise) {
      const child =
        children.find((c) => norm(c.title) === norm(r.task)) ??
        children.find((c) => norm(c.title).includes(norm(r.task)) || norm(r.task).includes(norm(c.title)))
      if (!child || !isSettled(child.status) || ids.includes(child.id)) continue
      const n = child.round + 1
      const note = `# ${emp.name}(${emp.role})의 검토 의견 (${n}차)\n\n${r.instructions}`
      if (child.sessionId) {
        startTask({ ...child, round: n }, `${note}\n\n위 의견을 반영해 이어서 진행하고, 끝나면 같은 형식으로 다시 보고하세요.`, { stay: true })
      } else {
        // 세션이 남아 있지 않으면 지시에 의견을 붙여 처음부터 다시 한다
        startTask({ ...child, round: n, instructions: `${child.instructions}\n\n${note}` }, undefined, { stay: true })
      }
      ids.push(child.id)
    }
    // 새로 맡기기
    ids.push(...startAssignments(cmd.delegate, tid, parent.cwd, { kind: 'delegate', parentTaskId: taskId }, exclude).taskIds)
    if (ids.length === 0) {
      // 맡길 수 있는 것이 하나도 없었다 (직원을 찾지 못함 등). 기다릴 것이 없으니 끝난 것으로 본다
      store.patchTask(taskId, { status: parentOf(parent) ? 'internal_review' : 'needs_review', delegation: undefined })
      finalizeRef.current(taskId)
      return
    }
    store.patchTask(taskId, { delegation: { round, taskIds: ids } })
  }

  // 조율 직원의 작업이 더 맡기지 않고 끝났다: 보고받은 하위 작업은 그 직원이 받아들인 것이므로 승인 처리한다
  finalizeRef.current = (taskId) => {
    const parent = teamRef.current.tasks.find((t) => t.id === taskId)
    if (!parent) return
    const who = teamRef.current.employees.find((e) => e.id === parent.employeeId)?.name ?? '맡긴 직원'
    for (const c of teamRef.current.tasks) {
      if (parentOf(c) === taskId && c.status === 'internal_review') store.patchTask(c.id, { status: 'approved', approvedBy: who })
    }
  }

  // 자리가 나면 대기 중인 작업을 넣은 순서대로 시작한다
  useEffect(() => {
    if (queueRef.current.length === 0) return
    const keep: typeof queueRef.current = []
    for (const item of queueRef.current) {
      const cur = store.tasks.find((t) => t.id === item.id)
      // 방금 넣은 작업은 이 시점의 목록에 아직 없거나 상태가 반영되지 않았을 수 있다. 잠깐은 기다려 준다
      const young = Date.now() - item.at < 8000
      if (!cur || cur.status !== 'queued') {
        if (young) keep.push(item)
        continue
      }
      if (keep.length > 0 || activeHere() >= limits.maxParallel) {
        keep.push(item)
        continue
      }
      startTask(cur, item.followUp, { ...item.opts, fromQueue: true, stay: true })
    }
    queueRef.current = keep
    // 아직 기다리는 것이 있으면 조금 뒤에 다시 본다 (작업 목록이 바뀌지 않아도 자리가 났을 수 있다)
    if (keep.length === 0) return
    const timer = setTimeout(() => setQueueTick((n) => n + 1), 2000)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.tasks, limits.maxParallel, queueTick])

  // 맡긴 작업이 모두 끝난 "팀 대기" 작업에게 보고를 돌려주고 이어서 진행시킨다.
  // 연결은 작업 기록(delegation)에 남아 있으므로 앱을 다시 켠 뒤에도 이어진다
  useEffect(() => {
    // 이 PC 의 이름을 알기 전에는 어느 PC 의 작업인지 가릴 수 없으므로 기다린다
    if (!hostname) return
    for (const parent of store.tasks) {
      if (parent.status !== 'waiting_team') {
        resumingRef.current.delete(parent.id)
        continue
      }
      if (!parent.delegation || resumingRef.current.has(parent.id)) continue
      // 다른 PC 에서 진행하던 작업은 여기서 이어 가지 않는다
      if (parent.runHost && parent.runHost !== hostname) continue
      const kids = parent.delegation.taskIds.map((id) => store.tasks.find((t) => t.id === id))
      const present = kids.filter((t): t is TeamTask => !!t)
      // 하나라도 진행 중이면(그 작업이 다시 팀을 기다리는 것 포함) 기다린다. 지워진 작업은 끝난 것으로 본다
      if (present.length === 0 || present.some((t) => !isSettled(t.status))) continue
      // 사용자가 중단한 작업이 있으면 알아서 이어 가지 않는다 (그 작업을 이어서 진행하거나, 상위 작업에서 "보고 받고 이어서 진행")
      if (present.some((t) => t.status === 'stopped')) continue
      collectReports(parent)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.tasks, hostname])

  // 채팅에서 배분한 작업이 끝나면(검토 요청·실패·중단) 보고서를 채팅에 올린다. 라운드마다 한 번
  const reportedRef = useRef(new Set<string>())
  useEffect(() => {
    const dispatched = new Set(items.flatMap((it) => (it.type === 'dispatch' ? it.taskIds : [])))
    if (dispatched.size === 0) return
    const fresh = store.tasks.filter(
      (t) =>
        dispatched.has(t.id) &&
        (t.status === 'needs_review' || t.status === 'failed' || t.status === 'stopped') &&
        !reportedRef.current.has(`${t.id}:${t.round}`)
    )
    if (fresh.length === 0) return
    for (const t of fresh) reportedRef.current.add(`${t.id}:${t.round}`)
    setItems((prev) => [
      ...prev,
      ...fresh.map((t) => ({ id: `r-${t.id}-${t.round}`, type: 'report' as const, taskId: t.id, round: t.round, report: t.report, error: t.error }))
    ])
  }, [store.tasks, items])

  const teamSummary = {
    running: store.tasks.filter((t) => isActive(t.status)).length,
    // 사용자가 봐야 하는 것만 센다 (직원끼리 검토하는 것은 빼고)
    attention: store.tasks.filter(needsUser).length
  }
  const permissionContext = (() => {
    if (!permission?.taskId) return undefined
    const t = store.tasks.find((x) => x.id === permission.taskId)
    const e = t && store.employees.find((x) => x.id === t.employeeId)
    return t ? `${e ? `${e.emoji} ${e.name}` : '직원'} · ${t.title}` : '팀 작업'
  })()
  // 오른쪽 패널에 보여줄 도구 호출: 팀 모드면 선택한 작업의 것
  const panelCalls = mode === 'team' ? (selectedTaskId ? runtimeRef.current[selectedTaskId]?.toolCalls ?? [] : []) : toolCalls

  // 백그라운드 탭: 세션별 작업 목록과, 탭 제목에 붙일 "지금 돌고 있는 것" 수
  const bgScopes: BgScope[] = Object.entries(bgTasks).map(([scope, tasks]) => {
    const t = scope === 'chat' ? undefined : store.tasks.find((x) => x.id === scope)
    const e = t ? store.employees.find((x) => x.id === t.employeeId) : undefined
    return {
      scope,
      label: scope === 'chat' ? '채팅 세션' : `${e?.emoji ?? '❔'} ${e?.name ?? '삭제된 직원'} · ${t?.title ?? '삭제된 작업'}`,
      live: scope === 'chat' ? running : !!t && isActive(t.status),
      tasks: Object.values(tasks).sort((a, b) => b.startedAt - a.startedAt)
    }
  })
  const bgRunning =
    (running ? 1 : 0) +
    store.tasks.filter((t) => isActive(t.status)).length +
    bgScopes.reduce((n, s) => n + visibleBgTasks(s.tasks).filter((t) => t.status === 'running' && t.background).length, 0)

  // 대화 내용이 바뀌면 저장 대상이 된다 (일반 답변, 팀장 배분·보고 카드, 메모리 안내 등 모두)
  useEffect(() => {
    if (skipDirtyOnce.current) {
      skipDirtyOnce.current = false
      return
    }
    if (items.some((it) => it.type === 'user')) dirty.current = true
  }, [items])

  // Claude 가 응답 중이 아닐 때 저장할 변경이 있으면 1.5초 뒤 Firestore 에 저장한다.
  // 문서 id 는 앱이 만들고, resume 용 Claude 세션 id 는 claudeSessionId 로 따로 둔다
  useEffect(() => {
    if (running || !dirty.current || !fbUser || !fbSettings?.enabled || !fbSettings.saveSessions) return
    if (!items.some((it) => it.type === 'user')) return
    const uid = fbUser.uid
    const t = setTimeout(() => {
      dirty.current = false
      const id = (docId.current ??= sessionId ?? crypto.randomUUID())
      const firstUser = items.find((it) => it.type === 'user')
      const title = firstUser && firstUser.type === 'user' ? firstUser.text.trim().slice(0, 60) : '(제목 없음)'
      const now = Date.now()
      createdAt.current ??= now
      setSync({ kind: 'saving' })
      fb.saveSession(uid, {
        id,
        // undefined 는 저장 시 빠지므로 빈 문자열로 "Claude 세션 없음" 을 남긴다
        claudeSessionId: sessionId ?? '',
        teamId,
        title,
        cwd,
        model: session?.model,
        createdAt: createdAt.current,
        updatedAt: now,
        numTurns: usage.numTurns,
        host: hostname,
        usage,
        items,
        toolCalls
      })
        .then(() => setSync({ kind: 'saved', at: now }))
        .catch((e) => {
          dirty.current = true
          setSync({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
        })
    }, 1500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, items, sessionId, fbUser, fbKey, teamId])

  const openSavedSession = async (id: string): Promise<void> => {
    if (running || !fbUser) return
    try {
      const s = await fb.loadSession(fbUser.uid, id)
      if (!s) return
      // 예전 문서는 id 가 곧 Claude 세션 id 였다. 새 문서는 claudeSessionId 를 따로 둔다 (없을 수도 있음)
      docId.current = s.id
      setSessionId(s.claudeSessionId === undefined ? s.id : s.claudeSessionId || undefined)
      // 그 세션에서 쓰던 팀을 함께 되돌린다 (세션별 팀이 생기기 전의 세션은 기존 팀)
      setTeamId(s.teamId ?? DEFAULT_TEAM_ID)
      setSelectedTaskId(null)
      setSession(null)
      setCwd(s.cwd)
      skipDirtyOnce.current = true
      setItems(s.items ?? [])
      setToolCalls(s.toolCalls ?? [])
      setUsage(s.usage ?? EMPTY_USAGE)
      setSelectedTool(null)
      createdAt.current = s.createdAt
      restored.current = true
      dirty.current = false
      setSync({ kind: 'idle' })
    } catch (e) {
      setItems((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          type: 'system',
          text: `세션 불러오기 실패: ${e instanceof Error ? e.message : String(e)}`,
          isError: true
        }
      ])
    }
  }

  const deleteSavedSession = async (id: string): Promise<void> => {
    if (!fbUser) return
    await fb.deleteSession(fbUser.uid, id).catch(() => undefined)
    if (id === docId.current) {
      createdAt.current = null
      docId.current = null
    }
  }

  const handleEvent = useCallback((ev: ClaudeEvent) => {
    // eslint-disable-next-line @typescript-eslint/no-use-before-define
    switch (ev.kind) {
      case 'session':
        setSessionId(ev.info.sessionId)
        setSession(ev.info)
        break
      case 'text_delta': {
        setItems((prev) => {
          if (streamingId.current) {
            return prev.map((it) =>
              it.id === streamingId.current && it.type === 'assistant'
                ? { ...it, text: it.text + ev.text }
                : it
            )
          }
          const id = `a-${Date.now()}-${Math.random()}`
          streamingId.current = id
          return [...prev, { id, type: 'assistant', text: ev.text, streaming: true }]
        })
        break
      }
      case 'text_done': {
        // setItems 의 updater 는 나중에 실행되므로 id 를 먼저 잡아 둔다 (안 그러면 커서가 계속 남는다)
        const sid = streamingId.current
        streamingId.current = null
        setItems((prev) => prev.map((it) => (it.id === sid && it.type === 'assistant' ? { ...it, streaming: false } : it)))
        break
      }
      case 'thinking_delta':
        break
      case 'tool_start':
        setToolCalls((prev) => [...prev, ev.call])
        // 서브에이전트 안의 도구는 채팅에는 따로 안 띄우고(부모 Agent 칩에 개수로 표시) 도구 로그 트리에만 넣는다
        if (!ev.call.parentId) {
          setItems((prev) => [...prev, { id: ev.call.id, type: 'tool', callId: ev.call.id }])
        }
        if (isEditTool(ev.call.name)) {
          setSelectedTool(ev.call.id)
          setRightTab('diff')
          openRight()
        }
        break
      case 'tool_result':
        setToolCalls((prev) =>
          prev.map((c) =>
            c.id === ev.id
              ? {
                  ...c,
                  status: ev.isError ? 'error' : 'done',
                  result: ev.result,
                  isError: ev.isError,
                  fileAfter: ev.fileAfter,
                  finishedAt: Date.now()
                }
              : c
          )
        )
        break
      case 'result':
        setSessionId(ev.sessionId)
        // 비용·턴 수는 세션을 이어갈 때(resume) SDK가 누적값을 돌려주므로 마지막 값을 쓰고,
        // 토큰·소요 시간은 요청 단위라 더한다.
        setUsage((prev) => ({
          totalCostUsd: ev.usage.totalCostUsd,
          numTurns: ev.usage.numTurns,
          inputTokens: prev.inputTokens + ev.usage.inputTokens,
          outputTokens: prev.outputTokens + ev.usage.outputTokens,
          cacheReadTokens: prev.cacheReadTokens + ev.usage.cacheReadTokens,
          cacheCreationTokens: prev.cacheCreationTokens + ev.usage.cacheCreationTokens,
          durationMs: prev.durationMs + ev.usage.durationMs
        }))
        if (ev.isError && ev.errorText) {
          setItems((prev) => [
            ...prev,
            { id: `e-${Date.now()}`, type: 'system', text: ev.errorText!, isError: true }
          ])
        }
        dirty.current = true
        setStatus('')
        break
      case 'subagent_info':
        setToolCalls((prev) =>
          prev.map((c) => {
            if (c.id !== ev.parentId) return c
            // undefined 로 기존 값을 덮어쓰지 않도록 정의된 필드만 병합
            const patch = Object.fromEntries(Object.entries(ev.info).filter(([, v]) => v !== undefined))
            return { ...c, subagent: { ...(c.subagent ?? {}), ...patch } }
          })
        )
        break
      case 'bg_task':
        applyBgTask('chat', ev.id, ev.patch)
        break
      case 'rate_limit':
        setPlan({ windows: ev.windows, isUsingOverage: ev.isUsingOverage, updatedAt: ev.updatedAt })
        break
      case 'error':
        setItems((prev) => [
          ...prev,
          { id: `e-${Date.now()}`, type: 'system', text: ev.message, isError: true }
        ])
        setStatus('')
        break
      case 'status':
        setStatus(ev.text)
        break
    }
  }, [])

  useEffect(() => {
    const offEvent = window.api.onEvent(handleEvent)
    const offPerm = window.api.onPermission((req) => {
      setPermissions((q) => (q.some((p) => p.requestId === req.requestId) ? q : [...q, req]))
      // 창이 뒤에 있으면 Windows 알림으로 알린다 (승인을 기다리며 작업이 멈춰 있지 않도록)
      const t = req.taskId ? teamRef.current.tasks.find((x) => x.id === req.taskId) : undefined
      const e = t && teamRef.current.employees.find((x) => x.id === t.employeeId)
      window.api.notify('권한 승인 필요', `${t ? `${e ? `${e.emoji} ${e.name} · ` : ''}${t.title}` : '채팅'} — ${req.toolName} 실행을 기다리고 있습니다`)
    })
    // 답하기 전에 취소된 요청(작업 중단 등)은 팝업에서 치우고, 그 작업의 "승인 필요" 표시도 푼다
    const offClosed = window.api.onPermissionClosed((requestId) => {
      const closed = permissionsRef.current.find((p) => p.requestId === requestId)
      setPermissions((q) => q.filter((p) => p.requestId !== requestId))
      const tid = closed?.taskId
      if (!tid || permissionsRef.current.some((p) => p.taskId === tid && p.requestId !== requestId)) return
      const t = teamRef.current.tasks.find((x) => x.id === tid)
      if (t?.status === 'waiting_permission') teamRef.current.upsertTask({ ...t, status: 'running' })
    })
    return () => {
      offEvent()
      offPerm()
      offClosed()
    }
  }, [handleEvent])

  /** 💾 버튼 또는 "기억해:" 명령으로 메모리를 만든다. command 는 바로 저장, chat 은 대화상자로 확인 */
  const rememberFromChat = (text: string, kind: 'chat' | 'command'): void => {
    const source: MemoryItem['source'] = { kind, sessionId, sessionTitle: currentTitle }
    if (kind === 'chat') {
      setRememberDraft({ text: text.length > 4000 ? text.slice(0, 4000) + '\n…(중략)' : text, source })
      return
    }
    const now = Date.now()
    memory.upsert({ id: crypto.randomUUID(), text, scope: 'project', cwd, enabled: true, source, createdAt: now, updatedAt: now })
    setItems((prev) => [
      ...prev,
      {
        id: `s-${now}`,
        type: 'system',
        text: `💾 메모리에 저장했습니다 (이 폴더): "${text.length > 80 ? text.slice(0, 80) + '…' : text}"\n다음 요청부터 적용됩니다. 설정 → 메모리에서 수정하거나 모든 폴더로 바꿀 수 있습니다.`
      }
    ])
  }

  const send = async (rawPrompt: string, attachments: Attachment[] = []): Promise<void> => {
    if ((!rawPrompt.trim() && attachments.length === 0) || running) return
    // "기억해: …" 는 Claude 에게 보내지 않고 메모리에 저장한다
    const rememberText = attachments.length === 0 ? parseRememberCommand(rawPrompt) : null
    if (rememberText) {
      setItems((prev) => [...prev, { id: `u-${Date.now()}`, type: 'user', text: rawPrompt }])
      rememberFromChat(rememberText, 'command')
      return
    }
    if (teamChat) return dispatchToTeam(rawPrompt, attachments)
    // 첨부 파일은 경로로 넘긴다. Claude Code 의 Read 도구가 텍스트·이미지·PDF 를 읽는다
    const prompt = withAttachments(rawPrompt, attachments)
    setItems((prev) => [...prev, { id: `u-${Date.now()}`, type: 'user', text: rawPrompt, attachments: attachments.length ? attachments : undefined }])
    setRunning(true)
    setStatus('요청 중…')
    try {
      try {
        await window.api.send({ prompt, cwd, sessionId, permissionMode, systemPromptAppend: memoryText })
      } catch (err) {
        // Firestore 에서 복원한 세션은 다른 PC 에서 만든 것일 수 있어 resume 이 실패한다 → 새 세션으로 다시 보낸다
        const msg = err instanceof Error ? err.message : String(err)
        if (restored.current && sessionId && /session|conversation|resume/i.test(msg)) {
          restored.current = false
          setSessionId(undefined)
          createdAt.current = null
          setItems((prev) => [
            ...prev,
            {
              id: `s-${Date.now()}`,
              type: 'system',
              text: '이전 세션을 이 PC 에서 이어갈 수 없어 새 세션으로 시작합니다.'
            }
          ])
          await window.api.send({ prompt, cwd, sessionId: undefined, permissionMode, systemPromptAppend: memoryText })
        } else {
          throw err
        }
      }
      restored.current = false
    } catch (err) {
      setItems((prev) => [
        ...prev,
        {
          id: `e-${Date.now()}`,
          type: 'system',
          text: err instanceof Error ? err.message : String(err),
          isError: true
        }
      ])
    } finally {
      setRunning(false)
      setStatus('')
      streamingId.current = null
      // 턴이 끝났는데 스트리밍 표시가 남은 항목이 있으면 정리
      setItems((prev) => (prev.some((it) => it.type === 'assistant' && it.streaming) ? prev.map((it) => (it.type === 'assistant' && it.streaming ? { ...it, streaming: false } : it)) : prev))
    }
  }

  const newSession = (): void => {
    if (running) return
    // 새 세션은 새 팀으로 시작한다. 이전 팀과 그 작업은 그대로 남아 계속 돌고, 팀 화면에서 다시 고를 수 있다
    setTeamId(crypto.randomUUID())
    setSelectedTaskId(null)
    setBgTasks(({ chat: _chat, ...rest }) => rest)
    setSessionId(undefined)
    setSession(null)
    setItems([])
    setToolCalls([])
    setUsage(EMPTY_USAGE)
    setSelectedTool(null)
    createdAt.current = null
    docId.current = null
    restored.current = false
    dirty.current = false
    setSync({ kind: 'idle' })
  }

  const pickFolder = async (): Promise<void> => {
    const folder = await window.api.pickFolder()
    if (folder) {
      setCwd(folder)
      newSession()
    }
  }

  // 오른쪽 패널(터미널·브라우저·폴더) → 채팅 입력창
  const insertToChat = (text: string): void => {
    setMode('chat')
    setInsertRequest({ text, nonce: Date.now() })
  }
  const attachToChat = (attachments: Attachment[]): void => {
    setMode('chat')
    setAttachRequest({ attachments, nonce: Date.now() })
  }

  const answerPermission = (allow: boolean, always = false): void => {
    if (!permission) return
    window.api.answerPermission({ requestId: permission.requestId, allow, always })
    if (permission.taskId) {
      // 팀 작업: 승인 대기 상태를 풀어 준다
      const tid = permission.taskId
      patchTaskRef.current(tid, (t) => (t.status === 'waiting_permission' ? { status: 'running' } : {}))
      if (!allow) {
        const rt = runtimeRef.current[tid]
        if (rt) {
          runtimeRef.current[tid] = {
            ...rt,
            toolCalls: rt.toolCalls.map((c) =>
              c.status === 'running' && c.name === permission.toolName ? { ...c, status: 'denied' } : c
            )
          }
          setRuntimeVersion((v) => v + 1)
        }
      }
    } else if (!allow) {
      setToolCalls((prev) =>
        prev.map((c) =>
          c.status === 'running' && c.name === permission.toolName ? { ...c, status: 'denied' } : c
        )
      )
    }
    setPermissions((q) => q.slice(1))
  }

  const selectTool = (id: string): void => {
    setSelectedTool(id)
    const call = panelCalls.find((c) => c.id === id)
    setRightTab(call && isEditTool(call.name) ? 'diff' : 'tools')
    openRight()
  }

  const saveConfig = async (next: AppConfig): Promise<void> => {
    setConfig(await window.api.setConfig(next))
  }
  const saveApiKey = async (key: string | null): Promise<void> => {
    setConfig(await window.api.setApiKey(key))
  }
  const changeModel = async (model: string | undefined): Promise<void> => {
    if (!config) return
    const { hasApiKey: _a, apiKeyHint: _b, hasUpdateToken: _c, ...plain } = config
    await saveConfig({ ...plain, model })
  }

  const changeEffort = async (effort: EffortLevel | undefined): Promise<void> => {
    if (!config) return
    const { hasApiKey: _a, apiKeyHint: _b, hasUpdateToken: _c, ...plain } = config
    await saveConfig({ ...plain, effort })
  }

  // 한 번만: 이전 버전의 모델 설정(CLI 기본값, 목록에 고정돼 있던 id)을 자동 선택으로 옮긴다.
  // 그 뒤로는 사용자가 고른 값(버전 고정·CLI 기본값 포함)을 그대로 둔다
  useEffect(() => {
    if (!config || localStorage.getItem(MODEL_MIGRATED_KEY)) return
    localStorage.setItem(MODEL_MIGRATED_KEY, '1')
    const next = config.model ? legacyToAuto(config.model) : AUTO
    if (next) void changeModel(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config])
  useEffect(() => {
    const key = `${MODEL_MIGRATED_KEY}.team.${store.backend}`
    if (store.employees.length === 0 || localStorage.getItem(key)) return
    localStorage.setItem(key, '1')
    for (const e of store.employees) {
      const next = legacyToAuto(e.model)
      // 이 버전 이후에 일부러 버전을 고정한 직원은 건드리지 않는다
      if (next && e.updatedAt < MODEL_AUTO_CUTOFF) store.upsertEmployee({ ...e, model: next })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.employees, store.backend])

  return (
    <div className="app" style={{ gridTemplateColumns: gridColumns }}>
      {layout.sidebarOpen ? (
        <Sidebar
        cwd={cwd}
        session={session}
        config={config}
        permissionMode={permissionMode}
        usage={usage}
        plan={plan}
        running={running}
        updateStatus={updateStatus}
        authStatus={authStatus}
        mode={mode}
        teamSummary={teamSummary}
        teamUsage={teamUsage}
        onModeChange={setMode}
        history={{
          enabled: !!(config?.firebase.enabled && config.firebase.config),
          cwd,
          user: fbUser,
          sessions: savedSessions,
          currentId: sessionId,
          hostname,
          sync,
          onOpen: openSavedSession,
          onDelete: deleteSavedSession
        }}
        onPickFolder={pickFolder}
        onNewSession={newSession}
        onPermissionModeChange={setPermissionMode}
        onModelChange={changeModel}
        onEffortChange={changeEffort}
        onOpenSettings={(tab) => setSettingsTab(tab)}
        onOpenSearch={() => setSearchOpen(true)}
        memoryCount={memoryCount}
      />
      ) : (
        <div />
      )}
      <div className="chat-col">
        {layout.sidebarOpen && (
          <Resizer
            side="left"
            onResize={resizeSidebar}
            onReset={() => setLayout((l) => ({ ...l, sidebarWidth: DEFAULT_LAYOUT.sidebarWidth }))}
          />
        )}
        <button
          className={`panel-toggle left ${layout.sidebarOpen ? '' : 'closed'}`}
          title={layout.sidebarOpen ? '사이드바 숨기기 (Ctrl+B)' : '사이드바 보이기 (Ctrl+B)'}
          onClick={toggleSidebar}
        >
          {layout.sidebarOpen ? '◀' : '☰'}
        </button>
        {!layout.rightOpen && (
          <button className="panel-toggle right closed" title="도구 패널 보이기 (Ctrl+J)" onClick={toggleRight}>
            {`🔧${panelCalls.length ? ` ${panelCalls.length}` : ''}`}
          </button>
        )}
      {mode === 'team' ? (
        <TeamView
          employees={team.employees}
          tasks={team.tasks}
          runtime={runtimeRef.current}
          selectedTaskId={selectedTaskId}
          defaultCwd={cwd}
          backend={team.backend}
          storeError={team.error}
          hostname={hostname}
          teamId={teamId}
          teams={scoped.rows}
          onSwitchTeam={switchTeam}
          onImportEmployees={scoped.importEmployees}
          onDeleteTeam={deleteTeam}
          decisions={store.teams.find((x) => x.id === teamId)?.decisions ?? []}
          limits={limits}
          onChangeLimits={setLimits}
          onStopTree={stopTree}
          onRemoveDecision={(id) => store.removeDecision(teamId, id)}
          onSetTeamPermission={(mode) => {
            for (const e of team.employees) if (e.permissionMode !== mode) store.upsertEmployee({ ...e, permissionMode: mode, updatedAt: Date.now() })
          }}
          pendingTaskIds={permissions.map((p) => p.taskId).filter((id): id is string => !!id)}
          onRecheckPermissions={() => void syncPermissions()}
          onSelectTask={(id) => {
            setSelectedTaskId(id)
            setSelectedTool(null)
          }}
          onSaveEmployee={team.upsertEmployee}
          onDeleteEmployee={team.removeEmployee}
          onStartTask={(t) => startTask(t)}
          onRerunTask={(t) => startTask({ ...t, sessionId: undefined, round: 0, reviews: t.reviews })}
          onStopTask={stopTask}
          onResumeTask={(t) => resumeTask(t)}
          onCollectReports={collectReports}
          onStopEmployee={stopEmployee}
          onResumeEmployee={resumeEmployee}
          onDeleteTask={(id) => {
            team.removeTask(id)
            const { [id]: _drop, ...rest } = runtimeRef.current
            runtimeRef.current = rest
            setBgTasks(({ [id]: _bg, ...others }) => others)
          }}
          onReview={reviewTask}
          onSelectTool={selectTool}
        />
      ) : (
      <Chat
        items={items}
        toolCalls={toolCalls}
        running={running}
        status={status}
        slashCommands={session?.slashCommands ?? []}
        insertRequest={insertRequest}
        attachRequest={attachRequest}
        teamMode={teamChat}
        tasks={store.tasks}
        employees={store.employees}
        onToggleTeamMode={() => setTeamChat((v) => !v)}
        onSend={send}
        onInterrupt={() => window.api.interrupt()}
        onSelectTool={selectTool}
        onReviewTask={reviewTask}
        onOpenTask={openTask}
        onRemember={(text) => rememberFromChat(text, 'chat')}
      />
      )}
        {layout.rightOpen && (
          <Resizer
            side="right"
            onResize={resizeRight}
            onReset={() => setLayout((l) => ({ ...l, rightWidth: DEFAULT_LAYOUT.rightWidth }))}
          />
        )}
      </div>
      {layout.rightOpen ? (
      <aside className="right">
        <div className="tabs">
          <button className="panel-toggle inline" title="도구 패널 숨기기 (Ctrl+J)" onClick={toggleRight}>
            ▶
          </button>
          <button className={rightTab === 'tools' ? 'active' : ''} onClick={() => setRightTab('tools')} title="도구 호출">
            도구 ({panelCalls.length})
          </button>
          <button className={rightTab === 'diff' ? 'active' : ''} onClick={() => setRightTab('diff')} title="변경 사항">
            변경
          </button>
          <button className={rightTab === 'tasks' ? 'active' : ''} onClick={() => setRightTab('tasks')} title="지금 진행 중인 요청과 백그라운드 작업">
            백그라운드{bgRunning > 0 ? ` (${bgRunning})` : ''}
          </button>
          <button className={rightTab === 'terminal' ? 'active' : ''} onClick={() => setRightTab('terminal')} title="터미널 (Ctrl+`)">
            터미널
          </button>
          <button className={rightTab === 'browser' ? 'active' : ''} onClick={() => setRightTab('browser')} title="내장 브라우저">
            브라우저
          </button>
          <button className={rightTab === 'files' ? 'active' : ''} onClick={() => setRightTab('files')} title="작업 폴더의 파일">
            폴더
          </button>
        </div>
        {rightTab === 'tools' && <ToolLog calls={panelCalls} selected={selectedTool} onSelect={selectTool} />}
        {rightTab === 'diff' && <DiffPanel calls={panelCalls} selected={selectedTool} onSelect={setSelectedTool} />}
        {rightTab === 'tasks' && (
          <BackgroundPanel
            scopes={bgScopes}
            chatRunning={running}
            chatStatus={status}
            employees={store.employees}
            teamTasks={store.tasks}
            onOpenTask={openTask}
            onStopTeamTask={stopTask}
            onClearFinished={() =>
              setBgTasks((all) =>
                Object.fromEntries(
                  Object.entries(all)
                    .map(([scope, tasks]) => [scope, Object.fromEntries(Object.entries(tasks).filter(([, t]) => t.status === 'running'))] as const)
                    .filter(([, tasks]) => Object.keys(tasks).length > 0)
                )
              )
            }
          />
        )}
        {openedTabs.terminal && (
          <div className="right-keep" style={{ display: rightTab === 'terminal' ? 'flex' : 'none' }}>
            <TerminalPanel cwd={cwd} visible={rightTab === 'terminal'} onInsertText={insertToChat} />
          </div>
        )}
        {openedTabs.browser && (
          <div className="right-keep" style={{ display: rightTab === 'browser' ? 'flex' : 'none' }}>
            <BrowserPanel onAttach={attachToChat} onInsertText={insertToChat} />
          </div>
        )}
        {rightTab === 'files' && (
          <FolderPanel cwd={cwd} refreshKey={panelCalls.length} onPickFolder={pickFolder} onAttach={attachToChat} onInsertText={insertToChat} />
        )}
      </aside>
      ) : (
        <div />
      )}
      {rememberDraft && (
        <MemoryDialog
          initial={{ text: rememberDraft.text, scope: 'project', cwd, source: rememberDraft.source }}
          cwd={cwd}
          onSave={(m) => {
            memory.upsert(m)
            setRememberDraft(null)
            setItems((prev) => [
              ...prev,
              {
                id: `s-${Date.now()}`,
                type: 'system',
                text: `💾 메모리에 저장했습니다 (${m.scope === 'global' ? '모든 폴더' : '이 폴더'}). 다음 요청부터 적용됩니다.`
              }
            ])
          }}
          onCancel={() => setRememberDraft(null)}
        />
      )}
      {searchOpen && (
        <SearchDialog
          user={fbUser}
          firebaseEnabled={!!fbSettings?.enabled}
          sessions={savedSessions}
          currentSessionId={sessionId}
          current={{ title: currentTitle, items }}
          tasks={store.tasks}
          employees={store.employees}
          cwd={cwd}
          onOpenSession={(id) => {
            setSearchOpen(false)
            void openSavedSession(id)
          }}
          onOpenTask={(id) => {
            setSearchOpen(false)
            openTask(id)
          }}
          onReference={(text) => {
            setSearchOpen(false)
            setMode('chat')
            setInsertRequest({ text, nonce: Date.now() })
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {permission && (
        <PermissionDialog
          request={permission}
          context={permissionContext}
          queued={permissions.length - 1}
          onAllow={() => answerPermission(true)}
          onAlwaysAllow={() => answerPermission(true, true)}
          onDeny={() => answerPermission(false)}
        />
      )}
      {settingsTab && config && (
        <SettingsDialog
          config={config}
          session={session}
          cwd={cwd}
          initialTab={settingsTab}
          updateStatus={updateStatus}
          authStatus={authStatus}
          teamBusy={teamSummary.running > 0}
          onRefreshAuth={refreshAuth}
          memory={memory}
          running={running}
          fbUser={fbUser}
          onSave={saveConfig}
          onSaveApiKey={saveApiKey}
          onInsertText={(text) => setInsertRequest({ text, nonce: Date.now() })}
          onClose={() => setSettingsTab(null)}
        />
      )}
    </div>
  )
}

/** 첨부 파일 경로를 프롬프트 끝에 덧붙인다. 직원 작업 지시에도 그대로 들어간다 */
function withAttachments(prompt: string, atts: Attachment[]): string {
  if (atts.length === 0) return prompt
  const lines = atts.map((a) => `- ${a.path}${a.mime ? ` (${a.mime})` : ''}`)
  return `${prompt.trim() || '첨부한 파일을 확인하고 내용을 설명해 주세요.'}\n\n첨부 파일 (Read 도구로 읽어서 참고하세요):\n${lines.join('\n')}`
}

export function isEditTool(name: string): boolean {
  return name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit'
}
