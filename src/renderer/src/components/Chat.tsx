import { useEffect, useRef, useState } from 'react'
import type { ToolCallRecord } from '../../../shared/types'
import { ToolChip } from './ToolChip'

export type ChatItem =
  | { id: string; type: 'user'; text: string }
  | { id: string; type: 'assistant'; text: string; streaming: boolean }
  | { id: string; type: 'tool'; callId: string }
  | { id: string; type: 'system'; text: string; isError?: boolean }

interface Props {
  items: ChatItem[]
  toolCalls: ToolCallRecord[]
  running: boolean
  status: string
  /** 세션이 알려준 슬래시 명령(스킬 포함). "/" 입력 시 자동완성에 쓴다 */
  slashCommands: string[]
  /** 설정 화면 등에서 입력창에 텍스트를 밀어넣을 때 */
  insertRequest: { text: string; nonce: number } | null
  onSend: (prompt: string) => void
  onInterrupt: () => void
  onSelectTool: (id: string) => void
}

export function Chat(p: Props) {
  const [draft, setDraft] = useState('')
  const [suggestIdx, setSuggestIdx] = useState(0)
  const bottomRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [p.items, p.toolCalls])

  useEffect(() => {
    if (p.insertRequest) {
      setDraft((d) => (d ? d + ' ' : '') + p.insertRequest!.text)
      textareaRef.current?.focus()
    }
  }, [p.insertRequest])

  const submit = (): void => {
    if (!draft.trim() || p.running) return
    p.onSend(draft)
    setDraft('')
    textareaRef.current?.focus()
  }

  const callById = (id: string): ToolCallRecord | undefined => p.toolCalls.find((c) => c.id === id)

  // "/abc" 처럼 한 단어만 입력된 상태에서만 자동완성
  const slashMatch = /^\/(\S*)$/.exec(draft)
  const suggestions = slashMatch
    ? p.slashCommands.filter((c) => c.toLowerCase().startsWith(slashMatch[1].toLowerCase())).slice(0, 8)
    : []

  const applySuggestion = (cmd: string): void => {
    setDraft(`/${cmd} `)
    setSuggestIdx(0)
    textareaRef.current?.focus()
  }

  return (
    <main className="chat">
      <div className="messages">
        {p.items.length === 0 && (
          <div className="empty">
            <h2>무엇을 도와드릴까요?</h2>
            <p>아래 입력창에 요청을 적으면 Claude Code가 선택한 폴더에서 작업합니다.</p>
            <p className="hint">
              예: "이 프로젝트 구조를 설명해줘", "README.md 만들어줘" · "/" 를 입력하면 스킬과 명령을 고를 수
              있습니다
            </p>
          </div>
        )}
        {p.items.map((it) => {
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
                  <div className="bubble">
                    {it.text}
                    {it.streaming && <span className="cursor" />}
                  </div>
                </div>
              )
            case 'tool': {
              const call = callById(it.callId)
              return call ? (
                <div key={it.id} className="msg tool">
                  <ToolChip call={call} onClick={() => p.onSelectTool(call.id)} />
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
        {p.running && p.status && <div className="status-line">{p.status}</div>}
        <div ref={bottomRef} />
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
        <div className="composer">
          <textarea
            ref={textareaRef}
            value={draft}
            placeholder="메시지를 입력하세요… (Enter 전송, Shift+Enter 줄바꿈, / 로 스킬 선택)"
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
              <button className="danger" onClick={p.onInterrupt}>
                중단
              </button>
            ) : (
              <button className="primary" onClick={submit} disabled={!draft.trim()}>
                전송
              </button>
            )}
          </div>
        </div>
      </div>
    </main>
  )
}
