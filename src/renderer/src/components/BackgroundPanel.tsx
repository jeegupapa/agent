// 백그라운드 작업 보기: 지금 앱에서 돌고 있는 일(채팅 응답, 직원 작업)과, 각 Claude 세션 안에서 따로 돌고 있는
// 작업(백그라운드 셸 명령, 서브에이전트 등 — CLI 의 /tasks 에 해당)을 한곳에서 본다.
import { useEffect, useState } from 'react'
import type { BgTask, Employee, TeamTask } from '../../../shared/types'
import { STATUS_LABEL, isActive } from '../team/runtime'

export interface BgScope {
  /** 'chat' 또는 팀 작업 id */
  scope: string
  label: string
  /** 그 세션이 지금 실행 중인지 (끝났으면 작업을 멈추거나 보낼 수 없다) */
  live: boolean
  tasks: BgTask[]
}

const TYPE_LABEL: Record<string, string> = {
  local_bash: '셸 명령',
  local_agent: '서브에이전트',
  local_workflow: '워크플로',
  mcp_task: 'MCP 작업',
  monitor: '모니터'
}
const BG_STATUS: Record<BgTask['status'], string> = { running: '실행 중', completed: '완료', failed: '실패', stopped: '중단됨' }

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}분 ${s % 60}초` : `${Math.floor(m / 60)}시간 ${m % 60}분`
}

/** 패널에 보여 줄 작업: 실행 중인 것 전부, 그리고 끝난 것 중 백그라운드였거나 서브에이전트였던 것 */
export function visibleBgTasks(tasks: BgTask[]): BgTask[] {
  return tasks.filter((t) => t.status === 'running' || t.background || t.type !== 'local_bash')
}

function TaskRow({ scope, live, t, now }: { scope: string; live: boolean; t: BgTask; now: number }) {
  const [output, setOutput] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = t.status === 'running'
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch {
      /* 이미 끝난 작업일 수 있다 */
    } finally {
      setBusy(false)
    }
  }
  const showOutput = async (): Promise<void> => {
    if (output !== null) return setOutput(null)
    if (!t.outputFile) return
    const r = await window.api.fsRead(t.outputFile)
    setOutput(r.kind === 'text' ? r.text.slice(-6000) || '(출력 없음)' : r.kind === 'error' ? `읽지 못했습니다: ${r.message}` : '(텍스트가 아닌 출력)')
  }
  return (
    <div className={`bg-task ${t.status}`}>
      <div className="bg-task-head">
        <span className={`bg-dot ${t.status}`} />
        <b className="bg-desc" title={t.description}>
          {t.description || '(설명 없음)'}
        </b>
        <span className={`bg-status ${t.status}`}>{BG_STATUS[t.status]}</span>
      </div>
      <div className="bg-meta muted small">
        <span>{TYPE_LABEL[t.type ?? ''] ?? t.type ?? '작업'}{t.subagentType ? ` · ${t.subagentType}` : ''}</span>
        <span>{t.background ? '백그라운드' : '포그라운드 (끝나기를 기다리는 중)'}</span>
        <span>{fmtElapsed((t.endedAt ?? now) - t.startedAt)}</span>
        {t.toolUses !== undefined && <span>도구 {t.toolUses}회</span>}
        {t.totalTokens !== undefined && <span>토큰 {(t.totalTokens / 1000).toFixed(1)}k</span>}
        {running && t.lastTool && <span className="warn">지금 {t.lastTool}</span>}
      </div>
      {t.summary && <div className="bg-summary small">{t.summary}</div>}
      <div className="bg-actions">
        {running && live && !t.background && t.toolUseId && (
          <button className="pbtn" disabled={busy} title="이 작업을 기다리지 않고 Claude 가 다음 일을 계속하게 합니다 (터미널의 Ctrl+B)" onClick={() => act(() => window.api.sendToBackground(scope, t.toolUseId))}>
            백그라운드로 보내기
          </button>
        )}
        {running && live && (
          <button className="pbtn danger" disabled={busy} onClick={() => act(() => window.api.stopBgTask(scope, t.id))}>
            중지
          </button>
        )}
        {!running && t.outputFile && (
          <button className="pbtn" onClick={() => void showOutput()}>
            {output === null ? '출력 보기' : '출력 닫기'}
          </button>
        )}
      </div>
      {output !== null && <pre className="bg-output">{output}</pre>}
    </div>
  )
}

export function BackgroundPanel(p: {
  scopes: BgScope[]
  chatRunning: boolean
  chatStatus: string
  employees: Employee[]
  teamTasks: TeamTask[]
  onOpenTask: (id: string) => void
  onStopTeamTask: (id: string) => void
  onClearFinished: () => void
}) {
  // 경과 시간을 1초마다 다시 그린다 (돌고 있는 것이 있을 때만)
  const [now, setNow] = useState(Date.now())
  const activeTeam = p.teamTasks.filter((t) => isActive(t.status))
  const anyRunning = p.chatRunning || activeTeam.length > 0 || p.scopes.some((s) => s.tasks.some((t) => t.status === 'running'))
  useEffect(() => {
    if (!anyRunning) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [anyRunning])

  const shown = p.scopes.map((s) => ({ ...s, tasks: visibleBgTasks(s.tasks) })).filter((s) => s.tasks.length > 0)
  const finished = shown.some((s) => s.tasks.some((t) => t.status !== 'running'))
  const emp = (id: string): Employee | undefined => p.employees.find((e) => e.id === id)

  return (
    <div className="bg-panel">
      <section>
        <h4>지금 진행 중</h4>
        {!p.chatRunning && activeTeam.length === 0 && <div className="muted small">진행 중인 요청이 없습니다.</div>}
        {p.chatRunning && (
          <div className="bg-work">
            <span className="bg-dot running" />
            <div className="bg-work-main">
              <b>채팅 응답</b>
              <span className="muted small">{p.chatStatus || 'Claude 가 응답하는 중'}</span>
            </div>
          </div>
        )}
        {activeTeam.map((t) => {
          const e = emp(t.employeeId)
          return (
            <div key={t.id} className="bg-work clickable" onClick={() => p.onOpenTask(t.id)} title="팀 화면에서 열기">
              <span className={`bg-dot ${t.status === 'waiting_permission' ? 'failed' : 'running'}`} />
              <div className="bg-work-main">
                <b>
                  {e?.emoji ?? '❔'} {e?.name ?? '삭제된 직원'} · {t.title}
                </b>
                <span className="muted small">
                  {STATUS_LABEL[t.status]} · {fmtElapsed(now - (t.startedAt ?? now))} · 도구 {t.progress.toolUses}회
                  {t.progress.lastTool ? ` · 지금 ${t.progress.lastTool}` : ''}
                </span>
              </div>
              <button
                className="pbtn danger"
                onClick={(ev) => {
                  ev.stopPropagation()
                  p.onStopTeamTask(t.id)
                }}
              >
                중단
              </button>
            </div>
          )
        })}
      </section>

      <section>
        <div className="bg-section-head">
          <h4>세션 안의 작업</h4>
          {finished && (
            <button className="pbtn" onClick={p.onClearFinished}>
              끝난 것 지우기
            </button>
          )}
        </div>
        {shown.length === 0 && (
          <div className="muted small">
            Claude 가 백그라운드로 돌린 셸 명령이나 서브에이전트가 여기에 표시됩니다. 지금은 없습니다.
          </div>
        )}
        {shown.map((s) => (
          <div key={s.scope} className="bg-scope">
            <div className="bg-scope-label small">{s.label}</div>
            {s.tasks.map((t) => (
              <TaskRow key={t.id} scope={s.scope} live={s.live} t={t} now={now} />
            ))}
          </div>
        ))}
      </section>
    </div>
  )
}
