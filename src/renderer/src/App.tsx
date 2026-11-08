import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AppConfig,
  AppConfigView,
  ClaudeEvent,
  PermissionRequest,
  PermissionMode,
  PlanWindow,
  SavedSessionMeta,
  SessionInfo,
  ToolCallRecord,
  UpdateStatus,
  UsageSummary
} from '../../shared/types'
import { Sidebar } from './components/Sidebar'
import { Chat, type ChatItem } from './components/Chat'
import { ToolLog } from './components/ToolLog'
import { DiffPanel } from './components/DiffPanel'
import { PermissionDialog } from './components/PermissionDialog'
import { SettingsDialog } from './components/SettingsDialog'
import type { SyncState } from './components/FirebasePanel'
import * as fb from './firebase'
import { Resizer } from './components/Resizer'
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

type RightTab = 'tools' | 'diff'
type SettingsTab = 'auth' | 'mcp' | 'skills' | 'update' | 'firebase'

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
  const [permission, setPermission] = useState<PermissionRequest | null>(null)
  const [rightTab, setRightTab] = useState<RightTab>('tools')
  const [selectedTool, setSelectedTool] = useState<string | null>(null)
  const [insertRequest, setInsertRequest] = useState<{ text: string; nonce: number } | null>(null)
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)
  const [layout, setLayout] = useState<PanelLayout>(loadLayout)
  const [hostname, setHostname] = useState('')
  const [fbUser, setFbUser] = useState<fb.FbUser | null>(null)
  const [savedSessions, setSavedSessions] = useState<SavedSessionMeta[]>([])
  const [sync, setSync] = useState<SyncState>({ kind: 'idle' })
  // 마지막 result 이후 아직 Firestore 에 저장하지 않은 변경이 있는지
  const dirty = useRef(false)
  // 세션을 처음 저장한 시각 (문서의 createdAt 유지용)
  const createdAt = useRef<number | null>(null)
  // Firestore 에서 불러온(복원한) 세션인지 — 이 PC 에서 이어가지 못할 수 있다
  const restored = useRef(false)

  // 스트리밍 중인 어시스턴트 텍스트 항목의 id
  const streamingId = useRef<string | null>(null)

  useEffect(() => {
    window.api.defaultCwd().then(setCwd)
    window.api.getConfig().then(setConfig)
    window.api.getUpdateStatus().then(setUpdateStatus)
    window.api.hostname().then(setHostname)
    return window.api.onUpdateStatus(setUpdateStatus)
  }, [])

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

  // 한 턴이 끝나고(running=false) 저장할 변경이 있으면 Firestore 에 저장
  useEffect(() => {
    if (running || !dirty.current || !sessionId || !fbUser || !fbSettings?.enabled || !fbSettings.saveSessions) return
    if (!items.some((it) => it.type === 'user')) return
    dirty.current = false
    const firstUser = items.find((it) => it.type === 'user')
    const title = firstUser && firstUser.type === 'user' ? firstUser.text.trim().slice(0, 60) : '(제목 없음)'
    const now = Date.now()
    createdAt.current ??= now
    setSync({ kind: 'saving' })
    fb.saveSession(fbUser.uid, {
      id: sessionId,
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
      .catch((e) => setSync({ kind: 'error', message: e instanceof Error ? e.message : String(e) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, sessionId, fbUser, fbKey])

  const openSavedSession = async (id: string): Promise<void> => {
    if (running || !fbUser) return
    try {
      const s = await fb.loadSession(fbUser.uid, id)
      if (!s) return
      setSessionId(s.id)
      setSession(null)
      setCwd(s.cwd)
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
    if (id === sessionId) createdAt.current = null
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
      case 'text_done':
        setItems((prev) =>
          prev.map((it) =>
            it.id === streamingId.current && it.type === 'assistant' ? { ...it, streaming: false } : it
          )
        )
        streamingId.current = null
        break
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
    const offPerm = window.api.onPermission((req) => setPermission(req))
    return () => {
      offEvent()
      offPerm()
    }
  }, [handleEvent])

  const send = async (prompt: string): Promise<void> => {
    if (!prompt.trim() || running) return
    setItems((prev) => [...prev, { id: `u-${Date.now()}`, type: 'user', text: prompt }])
    setRunning(true)
    setStatus('요청 중…')
    try {
      try {
        await window.api.send({ prompt, cwd, sessionId, permissionMode })
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
          await window.api.send({ prompt, cwd, sessionId: undefined, permissionMode })
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
    }
  }

  const newSession = (): void => {
    if (running) return
    setSessionId(undefined)
    setSession(null)
    setItems([])
    setToolCalls([])
    setUsage(EMPTY_USAGE)
    setSelectedTool(null)
    createdAt.current = null
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

  const answerPermission = (allow: boolean, always = false): void => {
    if (!permission) return
    window.api.answerPermission({ requestId: permission.requestId, allow, always })
    if (!allow) {
      setToolCalls((prev) =>
        prev.map((c) =>
          c.status === 'running' && c.name === permission.toolName ? { ...c, status: 'denied' } : c
        )
      )
    }
    setPermission(null)
  }

  const selectTool = (id: string): void => {
    setSelectedTool(id)
    const call = toolCalls.find((c) => c.id === id)
    setRightTab(call && isEditTool(call.name) ? 'diff' : 'tools')
    openRight()
  }

  const saveConfig = async (next: AppConfig): Promise<void> => {
    setConfig(await window.api.setConfig(next))
  }
  const saveApiKey = async (key: string | null): Promise<void> => {
    setConfig(await window.api.setApiKey(key))
  }

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
        onOpenSettings={(tab) => setSettingsTab(tab)}
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
        <button
          className={`panel-toggle right ${layout.rightOpen ? '' : 'closed'}`}
          title={layout.rightOpen ? '도구 패널 숨기기 (Ctrl+J)' : '도구 패널 보이기 (Ctrl+J)'}
          onClick={toggleRight}
        >
          {layout.rightOpen ? '▶' : `🔧${toolCalls.length ? ` ${toolCalls.length}` : ''}`}
        </button>
      <Chat
        items={items}
        toolCalls={toolCalls}
        running={running}
        status={status}
        slashCommands={session?.slashCommands ?? []}
        insertRequest={insertRequest}
        onSend={send}
        onInterrupt={() => window.api.interrupt()}
        onSelectTool={selectTool}
      />
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
          <button className={rightTab === 'tools' ? 'active' : ''} onClick={() => setRightTab('tools')}>
            도구 호출 ({toolCalls.length})
          </button>
          <button className={rightTab === 'diff' ? 'active' : ''} onClick={() => setRightTab('diff')}>
            변경 사항
          </button>
        </div>
        {rightTab === 'tools' ? (
          <ToolLog calls={toolCalls} selected={selectedTool} onSelect={selectTool} />
        ) : (
          <DiffPanel calls={toolCalls} selected={selectedTool} onSelect={setSelectedTool} />
        )}
      </aside>
      ) : (
        <div />
      )}
      {permission && (
        <PermissionDialog
          request={permission}
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

export function isEditTool(name: string): boolean {
  return name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit'
}
