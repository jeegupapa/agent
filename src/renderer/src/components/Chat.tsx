import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react'
import type { Attachment, Employee, TeamTask, ToolCallRecord } from '../../../shared/types'
import { ToolChip } from './ToolChip'
import { Markdown } from './Markdown'
import { STATUS_LABEL, isActive } from '../team/runtime'

export type ChatItem =
  | { id: string; type: 'user'; text: string; attachments?: Attachment[] }
  | { id: string; type: 'assistant'; text: string; streaming: boolean }
  | { id: string; type: 'tool'; callId: string }
  | { id: string; type: 'system'; text: string; isError?: boolean }
  /** 팀장이 요청을 직원 작업으로 배분한 결과. 작업 상태는 tasks 에서 실시간으로 읽는다 */
  | { id: string; type: 'dispatch'; summary: string; taskIds: string[] }
  /** 직원 보고서 (라운드별 스냅샷). 승인·수정 요청 버튼은 그 라운드가 최신일 때만 */
  | { id: string; type: 'report'; taskId: string; round: number; report?: string; error?: string }

interface Props {
  items: ChatItem[]
  toolCalls: ToolCallRecord[]
  running: boolean
  status: string
  /** 세션이 알려준 슬래시 명령(스킬 포함). "/" 입력 시 자동완성에 쓴다 */
  slashCommands: string[]
  /** 설정 화면 등에서 입력창에 텍스트를 밀어넣을 때 */
  insertRequest: { text: string; nonce: number } | null
  /** 켜져 있으면 입력한 요청을 팀장이 받아 직원에게 배분한다 */
  teamMode: boolean
  tasks: TeamTask[]
  employees: Employee[]
  onToggleTeamMode: () => void
  onSend: (prompt: string, attachments: Attachment[]) => void
  onInterrupt: () => void
  onSelectTool: (id: string) => void
  onReviewTask: (taskId: string, decision: 'approved' | 'changes_requested', comment: string) => void
  onOpenTask: (taskId: string) => void
  /** 메시지를 메모리로 저장 (💾 버튼) */
  onRemember: (text: string) => void
}

/** 이미지 첨부의 미리보기(data URL). 세션 저장에는 넣지 않고 렌더러 메모리에만 둔다 */
const previewCache = new Map<string, string>()

function fmtSize(n?: number): string {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`
  return `${(n / 1024 / 1024).toFixed(1)}MB`
}

/** 팀장 배분 요약: 길면 두 줄로 접고 누르면 펼친다 */
function DispatchSummary({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const long = text.length > 140
  return (
    <div className={`tc-summary ${long && !open ? 'clamp' : ''}`} onClick={() => long && setOpen((v) => !v)} title={long && !open ? '눌러서 전체 보기' : undefined}>
      {text}
    </div>
  )
}

function AttachChip(p: { a: Attachment; preview?: string; onRemove?: () => void }) {
  const isImage = p.a.mime?.startsWith('image/')
  return (
    <span className="attach-chip" title={p.a.path}>
      {isImage && p.preview ? <img src={p.preview} alt="" /> : <span className="attach-icon">{isImage ? '🖼️' : p.a.mime === 'application/pdf' ? '📕' : '📄'}</span>}
      <span className="attach-name">{p.a.name}</span>
      {p.a.size !== undefined && <span className="attach-size">{fmtSize(p.a.size)}</span>}
      {p.onRemove && (
        <button title="첨부 제거" onClick={p.onRemove}>
          ✕
        </button>
      )}
    </span>
  )
}

export function Chat(p: Props) {
  const [draft, setDraft] = useState('')
  const [suggestIdx, setSuggestIdx] = useState(0)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [, setPreviewVersion] = useState(0)
  const [dragging, setDragging] = useState(false)
  const messagesRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  /** 첨부 추가 (경로 중복 제거, 이미지는 미리보기 로드) */
  const addAttachments = (list: Attachment[]): void => {
    if (list.length === 0) return
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.path))
      return [...prev, ...list.filter((a) => a.path && !seen.has(a.path))]
    })
    for (const a of list) {
      if (a.mime?.startsWith('image/') && !previewCache.has(a.path)) {
        void window.api.attachmentPreview(a.path).then((url) => {
          if (url) {
            previewCache.set(a.path, url)
            setPreviewVersion((v) => v + 1)
          }
        })
      }
    }
    textareaRef.current?.focus()
  }
  const pickFiles = async (): Promise<void> => addAttachments(await window.api.pickFiles())
  const onDrop = (e: DragEvent): void => {
    e.preventDefault()
    setDragging(false)
    const files = [...e.dataTransfer.files]
    addAttachments(
      files
        .map((f) => ({ name: f.name, path: window.api.pathForFile(f), size: f.size, mime: f.type || undefined }))
        .filter((a) => a.path)
    )
  }
  const onPaste = async (e: ClipboardEvent): Promise<void> => {
    const images = [...e.clipboardData.items].filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
    if (images.length === 0) return
    e.preventDefault()
    for (const it of images) {
      const blob = it.getAsFile()
      if (!blob) continue
      const base64 = await new Promise<string>((resolve) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
        r.readAsDataURL(blob)
      })
      addAttachments([await window.api.saveClipboardImage({ base64, mime: it.type })])
    }
  }

  // 메시지 목록 안에서만 스크롤한다. scrollIntoView 는 body 까지 끌어내려 사이드바·오른쪽 패널이 화면 밖으로 밀려났다.
  useEffect(() => {
    const el = messagesRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [p.items, p.toolCalls])

  useEffect(() => {
    if (p.insertRequest) {
      // 여러 줄(참조 블록)은 줄을 바꿔 붙인다
      const text = p.insertRequest.text
      setDraft((d) => (d ? d + (text.includes('\n') ? '\n' : ' ') : '') + text)
      textareaRef.current?.focus()
    }
  }, [p.insertRequest])

  const canSend = (draft.trim().length > 0 || attachments.length > 0) && !p.running
  const submit = (): void => {
    if (!canSend) return
    p.onSend(draft, attachments)
    setDraft('')
    setAttachments([])
    textareaRef.current?.focus()
  }

  const callById = (id: string): ToolCallRecord | undefined => p.toolCalls.find((c) => c.id === id)
  const taskById = (id: string): TeamTask | undefined => p.tasks.find((t) => t.id === id)
  const employeeOf = (t: TeamTask | undefined): Employee | undefined =>
    t ? p.employees.find((e) => e.id === t.employeeId) : undefined

  // "/abc" 처럼 한 단어만 입력된 상태에서만 자동완성 (팀 모드에서는 슬래시 명령을 쓰지 않는다)
  const slashMatch = p.teamMode ? null : /^\/(\S*)$/.exec(draft)
  const suggestions = slashMatch
    ? p.slashCommands.filter((c) => c.toLowerCase().startsWith(slashMatch[1].toLowerCase())).slice(0, 8)
    : []

  const applySuggestion = (cmd: string): void => {
    setDraft(`/${cmd} `)
    setSuggestIdx(0)
    textareaRef.current?.focus()
  }

  const activeCount = p.tasks.filter((t) => isActive(t.status)).length

  return (
    <main className="chat">
      <div className="messages" ref={messagesRef}>
        {p.items.length === 0 &&
          (p.teamMode ? (
            <div className="empty">
              <h2>팀에게 무엇을 맡길까요?</h2>
              <p>요청을 적으면 팀장 에이전트가 읽고 적임 직원에게 작업으로 배분합니다. 맞는 직원이 없으면 템플릿에서 자동으로 채용합니다.</p>
              <p className="hint">
                직원들은 동시에 작업하고, 끝나면 보고서가 이 채팅으로 돌아옵니다. 여기서 바로 승인하거나 수정을 요청할 수
                있습니다.
              </p>
            </div>
          ) : (
            <div className="empty">
              <h2>무엇을 도와드릴까요?</h2>
              <p>아래 입력창에 요청을 적으면 Claude Code가 선택한 폴더에서 작업합니다.</p>
              <p className="hint">
                예: "이 프로젝트 구조를 설명해줘", "README.md 만들어줘" · "/" 를 입력하면 스킬과 명령을 고를 수
                있습니다 · "👥 팀에게 맡기기"를 켜면 직원들이 나눠서 처리합니다
              </p>
            </div>
          ))}
        {p.items.map((it) => {
          switch (it.type) {
            case 'user':
              return (
                <div key={it.id} className="msg user">
                  <div className="bubble">
                    {it.text}
                    {it.attachments && it.attachments.length > 0 && (
                      <div className="attach-list">
                        {it.attachments.map((a) => (
                          <AttachChip key={a.path} a={a} preview={previewCache.get(a.path)} />
                        ))}
                      </div>
                    )}
                  </div>
                  <button className="remember-btn" title="이 메시지를 메모리로 저장" onClick={() => p.onRemember(it.text)}>
                    💾
                  </button>
                </div>
              )
            case 'assistant':
              return (
                <div key={it.id} className="msg assistant">
                  <div className="bubble md">
                    <Markdown text={it.text} />
                    {it.streaming && <span className="cursor" />}
                  </div>
                  {!it.streaming && (
                    <button className="remember-btn" title="이 답변을 메모리로 저장" onClick={() => p.onRemember(it.text)}>
                      💾
                    </button>
                  )}
                </div>
              )
            case 'tool': {
              const call = callById(it.callId)
              return call ? (
                <div key={it.id} className="msg tool">
                  <ToolChip
                    call={call}
                    childCount={p.toolCalls.filter((c) => c.parentId === call.id).length}
                    onClick={() => p.onSelectTool(call.id)}
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
            case 'dispatch':
              return (
                <div key={it.id} className="msg teamcard">
                  <div className="team-card">
                    <div className="team-card-head">
                      <span className="tc-avatar lead">🧭</span>
                      <b>팀장 배분</b>
                      <span className="muted small">작업 {it.taskIds.length}건</span>
                    </div>
                    {it.summary && <DispatchSummary text={it.summary} />}
                    <ul className="dispatch-list">
                      {it.taskIds.map((id) => {
                        const t = taskById(id)
                        const e = employeeOf(t)
                        if (!t) {
                          return (
                            <li key={id} className="muted small">
                              (삭제된 작업)
                            </li>
                          )
                        }
                        return (
                          <li key={id} onClick={() => p.onOpenTask(id)} title="팀 화면에서 보기">
                            <span className="tc-avatar" style={{ background: e?.color }}>
                              {e?.emoji ?? '🤖'}
                            </span>
                            <span className="dispatch-who">
                              <b>{e?.name ?? '직원'}</b>
                              <span className="muted small">{e?.role}</span>
                            </span>
                            <span className="dispatch-title">{t.title}</span>
                            <span className={`task-status ${t.status}`}>{STATUS_LABEL[t.status]}</span>
                            {isActive(t.status) && (
                              <span className="muted small dispatch-progress">
                                도구 {t.progress.toolUses}회{t.progress.lastTool ? ` · ${t.progress.lastTool}` : ''}
                              </span>
                            )}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                </div>
              )
            case 'report': {
              const t = taskById(it.taskId)
              return (
                <ReportCard
                  key={it.id}
                  item={it}
                  task={t}
                  employee={employeeOf(t)}
                  onReview={p.onReviewTask}
                  onOpen={p.onOpenTask}
                />
              )
            }
          }
        })}
        {p.running && p.status && <div className="status-line">{p.status}</div>}
      </div>

      <div className="composer-wrap">
        {suggestions.length > 0 && (
          <ul className="suggest">
            {suggestions.map((c, i) => (
              <li
                key={c}
                className={i === suggestIdx ? 'active' : ''}
                onMouseDown={(e) => {
                  e.preventDefault()
                  applySuggestion(c)
                }}
              >
                /{c}
              </li>
            ))}
          </ul>
        )}
        <div className="composer-bar">
          <label className={`team-toggle ${p.teamMode ? 'on' : ''}`} title="켜면 요청을 팀장이 받아 직원들에게 배분합니다">
            <input type="checkbox" checked={p.teamMode} onChange={p.onToggleTeamMode} disabled={p.running} />
            <span className="knob" />
            👥 팀에게 맡기기
          </label>
          <span className="muted small">
            {p.teamMode
              ? activeCount > 0
                ? `직원 ${activeCount}명이 작업 중 · 보고서는 이 채팅으로 옵니다`
                : '팀장이 배분 → 직원들이 동시에 작업 → 보고서가 여기로 돌아옵니다'
              : 'Claude Code 가 직접 처리합니다'}
          </span>
        </div>
        {attachments.length > 0 && (
          <div className="attach-list">
            {attachments.map((a) => (
              <AttachChip
                key={a.path}
                a={a}
                preview={previewCache.get(a.path)}
                onRemove={() => setAttachments((prev) => prev.filter((x) => x.path !== a.path))}
              />
            ))}
          </div>
        )}
        <div
          className={`composer ${dragging ? 'dragging' : ''}`}
          onDragOver={(e) => {
            e.preventDefault()
            if (!dragging) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="composer-left">
            <button className="attach-btn" title="파일 첨부 (끌어다 놓기, 이미지 붙여넣기도 됩니다)" onClick={pickFiles} disabled={p.running}>
              +
            </button>
          </div>
          <textarea
            ref={textareaRef}
            value={draft}
            onPaste={onPaste}
            placeholder={
              p.teamMode
                ? '팀에게 맡길 요청을 적으세요… (Enter 전송, Shift+Enter 줄바꿈, 파일은 + 또는 끌어다 놓기)'
                : '메시지를 입력하세요… (Enter 전송, Shift+Enter 줄바꿈, / 로 스킬 선택, 파일은 + 또는 끌어다 놓기)'
            }
            rows={3}
            onChange={(e) => {
              setDraft(e.target.value)
              setSuggestIdx(0)
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return
              if (suggestions.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setSuggestIdx((i) => (i + 1) % suggestions.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setSuggestIdx((i) => (i - 1 + suggestions.length) % suggestions.length)
                  return
                }
                if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                  e.preventDefault()
                  applySuggestion(suggestions[suggestIdx])
                  return
                }
                if (e.key === 'Escape') {
                  setDraft(draft + ' ')
                  return
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="composer-actions">
            {p.running ? (
              <button className="danger" onClick={p.onInterrupt} disabled={p.teamMode} title={p.teamMode ? '배분이 끝날 때까지 잠시 기다려 주세요' : undefined}>
                중단
              </button>
            ) : (
              <button className="primary" onClick={submit} disabled={!canSend}>
                {p.teamMode ? '팀에게' : '전송'}
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}

/** 보고서에서 "한 일" 문장만 뽑아 한두 줄 요약으로 만든다. 없으면 첫 문단 */
function reportSummary(report: string | undefined): string {
  if (!report) return ''
  const m = /\*\*한 일\*\*\s*[:：]?\s*([\s\S]*?)(?=\n\s*\*\*|\n\s*##|$)/.exec(report)
  let text = (m ? m[1] : report.replace(/^##\s*보고\s*/m, ''))
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > 220) text = text.slice(0, 220) + '…'
  return text || '보고서 보기'
}

/** 채팅에 올라온 직원 보고서. 최신 라운드일 때만 승인·수정 요청 버튼을 보여준다 */
function ReportCard(p: {
  item: Extract<ChatItem, { type: 'report' }>
  task: TeamTask | undefined
  employee: Employee | undefined
  onReview: (taskId: string, decision: 'approved' | 'changes_requested', comment: string) => void
  onOpen: (taskId: string) => void
}) {
  const [asking, setAsking] = useState(false)
  const [comment, setComment] = useState('')
  const [expanded, setExpanded] = useState(false)
  const t = p.task
  const e = p.employee
  const latest = !!t && t.round === p.item.round
  const canReview = latest && t.status === 'needs_review'
  const label = t ? STATUS_LABEL[t.status] : '삭제됨'
  // 기본은 접힌 상태: "한 일" 한 줄만 보여 주고, 펼치면 전체 보고서
  const summary = reportSummary(p.item.report)
  return (
    <div className="msg teamcard">
      <div className="team-card report">
        <div className="team-card-head">
          <span className="tc-avatar" style={{ background: e?.color }}>
            {e?.emoji ?? '🤖'}
          </span>
          <b>{e?.name ?? '직원'}</b>
          <span className="muted small">{e?.role}</span>
          <span className={`task-status ${t?.status ?? 'stopped'}`}>{label}</span>
          <span className="muted small tc-title">
            {t?.title}
            {p.item.round > 0 ? ` · ${p.item.round}차 수정` : ''}
          </span>
        </div>
        {p.item.error && <div className="notice error">{p.item.error}</div>}
        {p.item.report ? (
          expanded ? (
            <div className="md tc-report">
              <Markdown text={p.item.report} />
            </div>
          ) : (
            <div className="tc-summary" onClick={() => setExpanded(true)} title="눌러서 전체 보고서 보기">
              {summary}
            </div>
          )
        ) : (
          !p.item.error && <div className="muted small">보고서 없이 끝났습니다. 작업 로그를 확인해 보세요.</div>
        )}
        {canReview &&
          (asking ? (
            <div className="row tc-actions">
              <input
                className="text"
                autoFocus
                value={comment}
                placeholder="무엇을 어떻게 고칠지 적으세요"
                onChange={(ev) => setComment(ev.target.value)}
                onKeyDown={(ev) => {
                  if (ev.nativeEvent.isComposing) return
                  if (ev.key === 'Enter' && comment.trim()) {
                    p.onReview(t.id, 'changes_requested', comment.trim())
                    setAsking(false)
                    setComment('')
                  }
                  if (ev.key === 'Escape') setAsking(false)
                }}
              />
              <button
                className="primary"
                disabled={!comment.trim()}
                onClick={() => {
                  p.onReview(t.id, 'changes_requested', comment.trim())
                  setAsking(false)
                  setComment('')
                }}
              >
                보내기
              </button>
              <button onClick={() => setAsking(false)}>취소</button>
            </div>
          ) : (
            <div className="row tc-actions">
              <button className="primary" onClick={() => p.onReview(t.id, 'approved', '')}>
                ✓ 승인
              </button>
              <button onClick={() => setAsking(true)}>수정 요청</button>
              {p.item.report && (
                <button className="ghost-btn" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? '접기' : '전체 보고서'}
                </button>
              )}
              <button className="ghost-btn" onClick={() => p.onOpen(t.id)}>
                팀에서 보기 →
              </button>
            </div>
          ))}
        {!canReview && t && (
          <div className="row tc-actions">
            {p.item.report && (
              <button className="ghost-btn" onClick={() => setExpanded((v) => !v)}>
                {expanded ? '접기' : '전체 보고서'}
              </button>
            )}
            <button className="ghost-btn" onClick={() => p.onOpen(t.id)}>
              팀에서 보기 →
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
