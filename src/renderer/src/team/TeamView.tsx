import { useEffect, useRef, useState } from 'react'
import type { Employee, ReviewDecision, TeamTask } from '../../../shared/types'
import { AnswerBox, extractQuestions } from './AnswerBox'
import { Markdown } from '../components/Markdown'
import { ToolChip } from '../components/ToolChip'
import { EmployeeForm, TaskForm } from './TeamForms'
import { EMPTY_RUNTIME, STATUS_LABEL, isActive, type TaskRuntime } from './runtime'
import { useModelCatalog } from '../models'
import { modelShort } from '../../../shared/models'

export interface TeamViewProps {
  employees: Employee[]
  tasks: TeamTask[]
  runtime: Record<string, TaskRuntime>
  selectedTaskId: string | null
  defaultCwd: string
  backend: 'firestore' | 'local'
  storeError?: string
  /** 이 PC 이름 (다른 PC 에서 실행한 작업을 구분) */
  hostname: string
  /** 이 창의 팝업 대기열에 권한 요청이 있는 작업 id */
  pendingTaskIds: string[]
  onRecheckPermissions: () => void
  onSelectTask: (id: string | null) => void
  onSaveEmployee: (e: Employee) => void
  onDeleteEmployee: (id: string) => void
  onStartTask: (task: TeamTask) => void
  onRerunTask: (task: TeamTask) => void
  onStopTask: (id: string) => void
  /** 중단된 작업을 같은 세션에서 이어서 진행 */
  onResumeTask: (task: TeamTask) => void
  /** 직원 한 명의 진행 중인 작업을 모두 중단 / 중단된 작업을 모두 이어서 진행 */
  onStopEmployee: (employeeId: string) => void
  onResumeEmployee: (employeeId: string) => void
  onDeleteTask: (id: string) => void
  onReview: (id: string, decision: ReviewDecision, comment: string) => void
  onSelectTool: (id: string) => void
}

function fmtTime(ms?: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay
    ? d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' }) +
        ' ' +
        d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
}

function fmtDuration(from?: number, to?: number): string {
  if (!from) return ''
  const s = Math.max(0, Math.floor(((to ?? Date.now()) - from) / 1000))
  if (s < 60) return `${s}초`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}분 ${s % 60}초` : `${Math.floor(m / 60)}시간 ${m % 60}분`
}

const GROUPS: { key: string; label: string; statuses: TeamTask['status'][] }[] = [
  { key: 'attention', label: '확인이 필요한 작업', statuses: ['waiting_permission', 'needs_review', 'failed'] },
  { key: 'active', label: '진행 중', statuses: ['running', 'changes_requested', 'queued'] },
  { key: 'done', label: '완료·중단', statuses: ['approved', 'stopped'] }
]

export function TeamView(p: TeamViewProps) {
  const catalog = useModelCatalog()
  const [showEmployeeForm, setShowEmployeeForm] = useState<false | 'new' | Employee>(false)
  const [showTaskForm, setShowTaskForm] = useState<false | { employeeId?: string }>(false)
  const [filterEmployee, setFilterEmployee] = useState<string | null>(null)
  const [, tick] = useState(0)
  // 진행 시간 갱신
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 10_000)
    return () => clearInterval(t)
  }, [])

  const empById = new Map(p.employees.map((e) => [e.id, e]))
  const tasks = filterEmployee ? p.tasks.filter((t) => t.employeeId === filterEmployee) : p.tasks
  const selected = p.tasks.find((t) => t.id === p.selectedTaskId) ?? null
  const runningCount = p.tasks.filter((t) => isActive(t.status)).length
  const reviewCount = p.tasks.filter((t) => t.status === 'needs_review' || t.status === 'waiting_permission').length

  return (
    <div className="team">
      <div className="team-head">
        <h2>
          팀 <span className="muted small">직원 {p.employees.length} · 진행 중 {runningCount} · 확인 필요 {reviewCount}</span>
        </h2>
        <span className="muted small" title={p.storeError}>
          {p.backend === 'firestore' ? 'Firebase 에 저장 중' : '이 PC 에 저장 중 (Firebase 로그인 시 동기화)'}
          {p.storeError ? ' · 저장 오류' : ''}
        </span>
        <span className="spacer" />
        <button onClick={() => setShowEmployeeForm('new')}>+ 직원</button>
        <button className="primary" disabled={p.employees.length === 0} onClick={() => setShowTaskForm({})}>
          + 작업 지시
        </button>
      </div>

      <div className="team-body">
        {/* 직원 목록 */}
        <aside className="emp-list">
          <button className={`emp-card all ${filterEmployee === null ? 'active' : ''}`} onClick={() => setFilterEmployee(null)}>
            <b>전체 작업</b>
            <span className="muted small">{p.tasks.length}개</span>
          </button>
          {p.employees.map((e) => {
            const mine = p.tasks.filter((t) => t.employeeId === e.id)
            const working = mine.filter((t) => isActive(t.status)).length
            const waiting = mine.filter((t) => t.status === 'needs_review' || t.status === 'waiting_permission').length
            const stopped = mine.filter((t) => t.status === 'stopped')
            return (
              <div
                key={e.id}
                className={`emp-card ${filterEmployee === e.id ? 'active' : ''}`}
                style={{ borderLeftColor: e.color }}
                onClick={() => setFilterEmployee(e.id)}
              >
                <div className="emp-top">
                  <span className="emp-emoji">{e.emoji}</span>
                  <div className="emp-name">
                    <b>{e.name}</b>
                    <span className="muted small">{e.role}</span>
                    <span className="emp-model" title={e.model || '사이드바의 기본 모델을 따름'}>
                      {modelShort(e.model, catalog)}
                    </span>
                  </div>
                  <button
                    className="ghost small-btn"
                    title="편집"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      setShowEmployeeForm(e)
                    }}
                  >
                    ✎
                  </button>
                </div>
                <div className="emp-status small">
                  {working > 0 ? (
                    <span className="warn">● 작업 중 {working}</span>
                  ) : (
                    <span className="muted">○ 대기</span>
                  )}
                  {waiting > 0 && <span className="danger"> · 확인 {waiting}</span>}
                </div>
                <div className="row">
                  <button
                    className="small-btn"
                    onClick={(ev) => {
                      ev.stopPropagation()
                      setShowTaskForm({ employeeId: e.id })
                    }}
                  >
                    작업 지시
                  </button>
                  {working > 0 && (
                    <button
                      className="small-btn danger"
                      title="이 직원이 하고 있는 작업을 모두 중단합니다. 나중에 이어서 진행할 수 있습니다"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        p.onStopEmployee(e.id)
                      }}
                    >
                      ⏸ 중단
                    </button>
                  )}
                  {stopped.length > 0 && (
                    <button
                      className="small-btn"
                      title="이 직원의 중단된 작업을 같은 세션에서 이어서 진행합니다"
                      onClick={(ev) => {
                        ev.stopPropagation()
                        const names = stopped.map((t) => `· ${t.title}`).join('\n')
                        if (stopped.length === 1 || confirm(`${e.name}의 중단된 작업 ${stopped.length}개를 이어서 진행할까요?\n${names}`)) p.onResumeEmployee(e.id)
                      }}
                    >
                      ▶ 이어서{stopped.length > 1 ? ` ${stopped.length}` : ''}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
          {p.employees.length === 0 && (
            <div className="muted small" style={{ padding: 8 }}>
              아직 직원이 없습니다. "+ 직원"으로 템플릿에서 만들어 보세요.
            </div>
          )}
        </aside>

        {/* 작업 목록 + 상세 */}
        <section className="task-area">
          <div className="task-list">
            {tasks.length === 0 && (
              <div className="empty">
                <h2>작업이 없습니다</h2>
                <p>직원을 고르고 "작업 지시"를 눌러 첫 작업을 맡겨 보세요. 끝나면 보고서가 여기 올라옵니다.</p>
              </div>
            )}
            {GROUPS.map((g) => {
              const list = tasks.filter((t) => g.statuses.includes(t.status))
              if (list.length === 0) return null
              return (
                <div key={g.key} className="task-group">
                  <h4>
                    {g.label} <span className="muted">{list.length}</span>
                  </h4>
                  {list.map((t) => {
                    const e = empById.get(t.employeeId)
                    return (
                      <div
                        key={t.id}
                        className={`task-row status-${t.status} ${t.id === p.selectedTaskId ? 'selected' : ''}`}
                        onClick={() => p.onSelectTask(t.id)}
                      >
                        <span className="task-emoji" title={e ? `${e.name} · ${e.role}` : ''}>
                          {e?.emoji ?? '❔'}
                        </span>
                        <div className="task-main">
                          <div className="task-title">
                            {t.title}
                            {t.round > 0 && <span className="badge">{t.round}차 수정</span>}
                            {t.status === 'needs_review' && extractQuestions(t.report).length > 0 && (
                              <span className="badge ask" title="보고서에 직원의 확인 요청이 있습니다. 열어서 답해 주세요">
                                ❓ 확인 요청 {extractQuestions(t.report).length}
                              </span>
                            )}
                          </div>
                          <div className="task-sub muted small">
                            {e?.name ?? '삭제된 직원'} · {isActive(t.status) ? fmtDuration(t.startedAt) + ' 경과' : fmtTime(t.finishedAt ?? t.createdAt)}
                            {t.progress.toolUses > 0 && ` · 도구 ${t.progress.toolUses}회`}
                            {isActive(t.status) && t.progress.lastTool && ` · ${t.progress.lastTool}`}
                          </div>
                        </div>
                        <span className={`task-status ${t.status}`}>{STATUS_LABEL[t.status]}</span>
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>

          {selected && (
            <TaskDetail
              task={selected}
              employee={empById.get(selected.employeeId)}
              runtime={p.runtime[selected.id] ?? EMPTY_RUNTIME}
              permissionPending={p.pendingTaskIds.includes(selected.id)}
              elsewhere={selected.runHost && p.hostname && selected.runHost !== p.hostname ? selected.runHost : undefined}
              onRecheckPermissions={p.onRecheckPermissions}
              onStop={() => p.onStopTask(selected.id)}
              onResume={() => p.onResumeTask(selected)}
              onRerun={() => p.onRerunTask(selected)}
              onDelete={() => {
                if (confirm(`"${selected.title}" 작업을 삭제할까요?`)) {
                  p.onDeleteTask(selected.id)
                  p.onSelectTask(null)
                }
              }}
              onReview={(d, c) => p.onReview(selected.id, d, c)}
              onSelectTool={p.onSelectTool}
              onClose={() => p.onSelectTask(null)}
            />
          )}
        </section>
      </div>

      {showEmployeeForm && (
        <EmployeeForm
          initial={showEmployeeForm === 'new' ? undefined : showEmployeeForm}
          onSave={(e) => {
            p.onSaveEmployee(e)
            setShowEmployeeForm(false)
          }}
          onCancel={() => setShowEmployeeForm(false)}
          onDelete={
            showEmployeeForm === 'new'
              ? undefined
              : () => {
                  p.onDeleteEmployee(showEmployeeForm.id)
                  setShowEmployeeForm(false)
                }
          }
        />
      )}
      {showTaskForm && (
        <TaskForm
          employees={p.employees}
          defaultEmployeeId={showTaskForm.employeeId ?? filterEmployee ?? undefined}
          defaultCwd={p.defaultCwd}
          onSubmit={(t) => {
            setShowTaskForm(false)
            p.onStartTask(t)
            p.onSelectTask(t.id)
          }}
          onCancel={() => setShowTaskForm(false)}
        />
      )}
    </div>
  )
}

function TaskDetail(p: {
  task: TeamTask
  employee?: Employee
  runtime: TaskRuntime
  /** 이 창의 팝업 대기열에 이 작업의 권한 요청이 있는지 */
  permissionPending: boolean
  /** 다른 PC 에서 실행한 작업이면 그 PC 이름 */
  elsewhere?: string
  onRecheckPermissions: () => void
  onStop: () => void
  onResume: () => void
  onRerun: () => void
  onDelete: () => void
  onReview: (decision: ReviewDecision, comment: string) => void
  onSelectTool: (id: string) => void
  onClose: () => void
}) {
  const { task: t, employee: e, runtime: rt } = p
  const [comment, setComment] = useState('')
  const [tab, setTab] = useState<'report' | 'log' | 'instructions'>(t.status === 'needs_review' ? 'report' : 'log')
  const logRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (tab === 'log') logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [rt.items, tab])
  useEffect(() => {
    if (t.status === 'needs_review') setTab('report')
  }, [t.status, t.id])

  const active = isActive(t.status)
  const callById = (id: string) => rt.toolCalls.find((c) => c.id === id)
  // 보고서의 "확인 요청" 항목. 검토 대기 중일 때만 답변 칸을 보여준다
  const questions = t.status === 'needs_review' ? extractQuestions(t.report) : []
  const canFollowUp = t.status === 'needs_review' || t.status === 'failed' || t.status === 'stopped' || t.status === 'approved'
  const sendComment = (decision: 'answered' | 'changes_requested'): void => {
    if (!comment.trim()) return
    p.onReview(decision, comment.trim())
    setComment('')
  }

  return (
    <div className="task-detail">
      <div className="task-detail-head">
        <span className="task-emoji">{e?.emoji ?? '❔'}</span>
        <div className="task-main">
          <div className="task-title">{t.title}</div>
          <div className="muted small">
            {e ? `${e.name} · ${e.role}` : '삭제된 직원'} · <span className="mono">{t.cwd}</span>
          </div>
        </div>
        <span className={`task-status ${t.status}`}>{STATUS_LABEL[t.status]}</span>
        <button className="ghost" onClick={p.onClose} title="닫기">
          ✕
        </button>
      </div>

      <div className="task-meta muted small">
        {t.startedAt && <span>시작 {fmtTime(t.startedAt)}</span>}
        {(t.startedAt || t.finishedAt) && <span>소요 {fmtDuration(t.startedAt, t.finishedAt)}</span>}
        <span>도구 {t.progress.toolUses}회</span>
        {t.progress.numTurns !== undefined && <span>턴 {t.progress.numTurns}</span>}
        {t.progress.totalTokens !== undefined && <span>토큰 {(t.progress.totalTokens / 1000).toFixed(1)}k</span>}
        {active && t.progress.lastTool && <span className="warn">지금 {t.progress.lastTool} 실행 중</span>}
        {active && p.elsewhere && t.status !== 'waiting_permission' && <span>실행 위치 {p.elsewhere}</span>}
        {t.status === 'waiting_permission' &&
          (p.permissionPending ? (
            <span className="danger">권한 승인을 기다리는 중 (팝업 확인)</span>
          ) : p.elsewhere ? (
            <span className="danger">{p.elsewhere} 에서 권한 승인을 기다리는 중입니다. 그 PC 의 앱에서 승인하세요.</span>
          ) : (
            <span className="danger perm-missing">
              권한 승인을 기다리는데 이 창에 팝업이 없습니다. 다른 창에서 실행한 작업이면 그 창에서 승인하세요.
              <button className="pbtn" onClick={p.onRecheckPermissions}>
                팝업 다시 불러오기
              </button>
            </span>
          ))}
      </div>

      <div className="tabs">
        <button className={tab === 'report' ? 'active' : ''} onClick={() => setTab('report')}>
          보고서{t.report ? '' : ' (없음)'}
        </button>
        <button className={tab === 'log' ? 'active' : ''} onClick={() => setTab('log')}>
          작업 로그 ({rt.toolCalls.length})
        </button>
        <button className={tab === 'instructions' ? 'active' : ''} onClick={() => setTab('instructions')}>
          지시 내용
        </button>
      </div>

      {tab === 'report' && (
        <div className="task-report">
          {t.error && <div className="notice error">{t.error}</div>}
          {/* 확인 요청은 스크롤 없이 바로 답할 수 있게 보고서보다 위에 둔다 */}
          {questions.length > 0 && <AnswerBox key={`${t.id}:${t.round}`} questions={questions} onSend={(text) => p.onReview('answered', text)} />}
          {t.report ? (
            <div className="bubble md">
              <Markdown text={t.report} />
            </div>
          ) : (
            <div className="muted small">{active ? '작업이 끝나면 보고서가 올라옵니다.' : '보고서가 없습니다.'}</div>
          )}
          {t.reviews.length > 0 && (
            <div className="review-history">
              {t.reviews.map((r, i) => (
                <div key={i} className="small review-item">
                  <b>{r.decision === 'approved' ? '승인' : r.decision === 'answered' ? '답변' : '수정 요청'}</b> {fmtTime(r.at)}
                  {r.comment ? ` — ${r.comment}` : ''}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'log' && (
        <div className="task-log" ref={logRef}>
          {rt.items.length === 0 && (
            <div className="muted small">
              {active ? '직원이 작업을 시작했습니다. 출력이 여기 흐릅니다…' : '이 PC 에서 실행된 로그가 없습니다. (앱을 다시 켜면 실시간 로그는 비워집니다)'}
            </div>
          )}
          {rt.items.map((it) => {
            switch (it.type) {
              case 'user':
                return (
                  <div key={it.id} className="msg user">
                    <div className="bubble">{it.text}</div>
                  </div>
                )
              case 'assistant':
                return (
                  <div key={it.id} className="msg assistant">
                    <div className="bubble md">
                      <Markdown text={it.text} />
                      {it.streaming && <span className="cursor" />}
                    </div>
                  </div>
                )
              case 'tool': {
                const c = callById(it.callId)
                return c ? (
                  <div key={it.id} className="msg tool">
                    <ToolChip
                      call={c}
                      childCount={rt.toolCalls.filter((x) => x.parentId === c.id).length}
                      onClick={() => p.onSelectTool(c.id)}
                    />
                  </div>
                ) : null
              }
              case 'system':
                return (
                  <div key={it.id} className={it.isError ? 'msg system error' : 'msg system'}>
                    {it.text}
                  </div>
                )
            }
          })}
        </div>
      )}

      {tab === 'instructions' && (
        <div className="task-report">
          <pre style={{ maxHeight: 'none' }}>{t.instructions}</pre>
          {e && (
            <details>
              <summary className="muted small">직원 지시문 보기</summary>
              <pre style={{ maxHeight: 'none' }}>{e.instructions}</pre>
            </details>
          )}
        </div>
      )}

      <div className="task-actions">
        {active && (
          <button className="danger" onClick={p.onStop}>
            중단
          </button>
        )}
        {t.status === 'stopped' && (
          <button className="primary" onClick={p.onResume} title={t.sessionId ? '중단된 곳에서 같은 세션으로 이어서 진행합니다' : '세션이 만들어지기 전에 중단되어 처음부터 시작합니다'}>
            ▶ 이어서 진행
          </button>
        )}
        {(t.status === 'failed' || t.status === 'stopped') && (
          <button onClick={p.onRerun}>처음부터 다시 실행</button>
        )}
        {!active && (
          <button className="ghost" onClick={p.onDelete}>
            삭제
          </button>
        )}
        <span className="spacer" />
        {canFollowUp && (
          <>
            <input
              className="text"
              placeholder="직원에게 보낼 답변 또는 수정 요청 내용"
              value={comment}
              onChange={(ev) => setComment(ev.target.value)}
              onKeyDown={(ev) => {
                if (ev.nativeEvent.isComposing) return
                if (ev.key === 'Enter') sendComment('changes_requested')
              }}
            />
            <button disabled={!comment.trim()} onClick={() => sendComment('answered')} title="직원의 질문·확인 요청에 답합니다. 직원이 답을 반영해 이어서 진행합니다">
              💬 답변
            </button>
            <button disabled={!comment.trim()} onClick={() => sendComment('changes_requested')} title="결과물을 고치라고 지시합니다">
              수정 요청
            </button>
            {t.status === 'needs_review' && (
              <button className="primary" onClick={() => p.onReview('approved', comment.trim())}>
                승인
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
