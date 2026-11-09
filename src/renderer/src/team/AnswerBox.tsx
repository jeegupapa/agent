import { useState, type KeyboardEvent } from 'react'

/**
 * 직원 보고서의 "남은 문제 / 확인 요청" 에 바로 답하는 곳.
 * 보고서에서 질문 항목을 뽑아 항목마다 답변 칸을 주고, 답을 한 묶음으로 만들어 같은 작업(세션)에 이어서 보낸다.
 */

const NONE = /^[\s"'“”‘’(（\-–—·•*]*(없음|없습니다|없어요|해당\s*없음|특이\s*사항\s*없음|none|n\/?a|nothing)[\s"'“”‘’)）.。!]*$/i

/** 보고서에서 확인 요청 항목들을 뽑는다. 없거나 "없음"이면 빈 배열 */
export function extractQuestions(report: string | undefined): string[] {
  if (!report) return []
  const lines = report.replace(/\r/g, '').split('\n')
  // "**남은 문제 / 확인 요청**: …" 또는 "### 확인 요청" 같은 제목 줄을 찾는다 (여러 개면 마지막 것)
  const head = (l: string): { rest: string } | null => {
    let m = /^\s*(?:[-*]\s+)?\*\*([^*\n]{1,40}?)\*\*\s*[:：]?\s*(.*)$/.exec(l)
    if (!m) m = /^\s*#{1,6}\s+([^:：\n]{1,40}?)\s*(?:[:：]\s*(.*))?$/.exec(l)
    if (!m) return null
    if (!/(확인\s*요청|확인이?\s*필요|질문)/.test(m[1])) return null
    return { rest: (m[2] ?? '').trim() }
  }
  let start = -1
  let first = ''
  for (let i = 0; i < lines.length; i++) {
    const h = head(lines[i])
    if (h) {
      start = i
      first = h.rest
    }
  }
  if (start < 0) return []
  const body: string[] = first ? [first] : []
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]
    // 다음 항목 제목(줄 맨 앞의 **…**: 또는 # 제목)이 나오면 끝. 목록 안의 굵은 글씨는 질문의 일부로 본다
    if (/^\s*#{1,6}\s/.test(l) || /^\*\*[^*\n]+\*\*\s*[:：]/.test(l) || /^\*\*[^*\n]+[:：]\*\*/.test(l)) break
    body.push(l)
  }
  // 목록 기호 기준으로 항목을 나눈다. 기호가 없으면 통째로 한 항목
  const items: string[] = []
  let cur: string[] = []
  const flush = (): void => {
    const t = cur.join('\n').trim()
    if (t) items.push(t)
    cur = []
  }
  for (const l of body) {
    const m = /^\s{0,3}(?:[-*•]|\d+[.)])\s+(.*)$/.exec(l)
    if (m) {
      flush()
      cur.push(m[1])
    } else if (l.trim() === '') {
      if (cur.length) cur.push('')
    } else cur.push(l.trim())
  }
  flush()
  return items.filter((t) => !NONE.test(t)).slice(0, 10)
}

function oneLine(s: string, max = 400): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/** 질문별 답과 추가 전달 사항을 직원에게 보낼 한 덩어리 텍스트로 */
export function composeAnswer(questions: string[], answers: string[], extra: string): string {
  const parts: string[] = []
  questions.forEach((q, i) => {
    const a = (answers[i] ?? '').trim()
    if (a) parts.push(`${parts.length + 1}. 확인 요청: ${oneLine(q)}\n   답변: ${a}`)
  })
  const skipped = questions.filter((_, i) => !(answers[i] ?? '').trim()).length
  if (questions.length > 0 && skipped > 0 && parts.length > 0) parts.push(`(답하지 않은 ${skipped}건은 가장 안전한 쪽으로 판단해 진행하세요.)`)
  if (extra.trim()) parts.push(questions.length > 0 ? `추가 전달: ${extra.trim()}` : extra.trim())
  return parts.join('\n\n')
}

interface Props {
  /** 보고서에서 뽑은 확인 요청. 비어 있으면 자유 답변 칸 하나만 */
  questions: string[]
  onSend: (text: string) => void
  onCancel?: () => void
}

export function AnswerBox(p: Props) {
  const [answers, setAnswers] = useState<string[]>([])
  const [extra, setExtra] = useState('')
  const text = composeAnswer(p.questions, answers, extra)
  const send = (): void => {
    if (!text) return
    p.onSend(text)
    setAnswers([])
    setExtra('')
  }
  const onKey = (ev: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (ev.nativeEvent.isComposing) return
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault()
      send()
    }
    if (ev.key === 'Escape' && p.onCancel) p.onCancel()
  }
  const rowsFor = (v: string): number => Math.min(6, Math.max(1, v.split('\n').length))
  const has = p.questions.length > 0
  return (
    <div className="answer-box">
      <div className="answer-head">
        <b>{has ? `❓ 직원의 확인 요청 ${p.questions.length}건` : '💬 직원에게 답변'}</b>
        <span className="muted small">답을 보내면 같은 작업에서 이어서 진행하고 다시 보고합니다</span>
      </div>
      {p.questions.map((q, i) => (
        <div key={i} className="answer-item">
          <div className="answer-q">
            <span className="answer-n">{i + 1}</span>
            <span className="answer-q-text">{q}</span>
          </div>
          <textarea
            className="text"
            rows={rowsFor(answers[i] ?? '')}
            placeholder="답변 (비워 두면 직원 판단에 맡깁니다)"
            value={answers[i] ?? ''}
            autoFocus={i === 0 && !!p.onCancel}
            onChange={(ev) => {
              const next = [...answers]
              next[i] = ev.target.value
              setAnswers(next)
            }}
            onKeyDown={onKey}
          />
        </div>
      ))}
      <textarea
        className="text"
        rows={has ? rowsFor(extra) : Math.max(2, rowsFor(extra))}
        placeholder={has ? '추가로 전할 말 (선택)' : '직원의 질문이나 보고 내용에 대한 답을 적으세요'}
        value={extra}
        autoFocus={!has}
        onChange={(ev) => setExtra(ev.target.value)}
        onKeyDown={onKey}
      />
      <div className="row answer-actions">
        <button className="primary" disabled={!text} onClick={send} title="Ctrl+Enter">
          답변 보내기
        </button>
        {p.onCancel && <button onClick={p.onCancel}>취소</button>}
        <span className="muted small">Ctrl+Enter 로 보내기</span>
      </div>
    </div>
  )
}
