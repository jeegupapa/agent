import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Employee, SavedSessionMeta, TeamTask } from '../../../shared/types'
import type { ChatItem } from './Chat'
import * as fb from '../firebase'
import { normPath } from '../memory/store'

/** 검색 결과 한 건 */
export interface SearchHit {
  key: string
  kind: 'chat' | 'task' | 'report'
  sessionId?: string
  taskId?: string
  title: string
  when: number
  cwd: string
  /** 나 / Claude / 직원 보고서 … */
  role: string
  /** 원문 (참조 삽입용) */
  text: string
  /** 공백을 한 칸으로 줄인 본문 (스니펫용) */
  flat: string
  index: number
  matchLen: number
}

/** 세션 문서 캐시: 검색할 때 한 번 내려받고 updatedAt 이 바뀐 것만 다시 받는다 */
const cache = new Map<string, { updatedAt: number; items: ChatItem[] }>()

/** 현재 채팅 입력창에 넣을 참조 블록 */
export function referenceText(h: SearchHit): string {
  const when = new Date(h.when).toLocaleDateString('ko-KR')
  const head =
    h.kind === 'chat'
      ? `참조: "${h.title}" (${when}) · ${h.role}`
      : h.kind === 'report'
        ? `참조: 직원 보고서 "${h.title}" (${when})`
        : `참조: 팀 작업 지시 "${h.title}" (${when})`
  const body = h.text.length > 2500 ? h.text.slice(0, 2500) + '\n…(중략)' : h.text
  return `> ${head}\n${body
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n')}\n\n`
}

export function SearchDialog(p: {
  user: fb.FbUser | null
  firebaseEnabled: boolean
  sessions: SavedSessionMeta[]
  currentSessionId?: string
  current: { title: string; items: ChatItem[] }
  tasks: TeamTask[]
  employees: Employee[]
  cwd: string
  onOpenSession: (id: string) => void
  onOpenTask: (id: string) => void
  onReference: (text: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [onlyHere, setOnlyHere] = useState(false)
  const [loaded, setLoaded] = useState(0)
  const [loading, setLoading] = useState(false)
  const [version, setVersion] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const canLoad = !!p.user && p.firebaseEnabled && fb.isReady()

  useEffect(() => inputRef.current?.focus(), [])

  // 저장된 세션 본문을 내려받는다 (4개씩 병렬)
  useEffect(() => {
    if (!canLoad || !p.user) return
    const uid = p.user.uid
    const missing = p.sessions.filter((s) => {
      const c = cache.get(s.id)
      return !c || c.updatedAt < s.updatedAt
    })
    setLoaded(p.sessions.length - missing.length)
    if (missing.length === 0) return
    let cancelled = false
    setLoading(true)
    const queue = missing.slice()
    const worker = async (): Promise<void> => {
      while (queue.length && !cancelled) {
        const s = queue.shift()!
        try {
          const doc = await fb.loadSession(uid, s.id)
          if (doc) cache.set(s.id, { updatedAt: s.updatedAt, items: doc.items ?? [] })
        } catch {
          /* 다음 세션으로 */
        }
        if (!cancelled) {
          setLoaded((n) => n + 1)
          setVersion((v) => v + 1)
        }
      }
    }
    void Promise.all([worker(), worker(), worker(), worker()]).then(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [canLoad, p.user, p.sessions])

  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const wordsKey = words.join(' ')
  const hits = useMemo(() => {
    if (words.length === 0) return []
    const out: SearchHit[] = []
    const consider = (h: Omit<SearchHit, 'index' | 'matchLen' | 'flat'>): void => {
      const flat = h.text.replace(/\s+/g, ' ')
      const lower = flat.toLowerCase()
      let first = Infinity
      let firstLen = 0
      for (const w of words) {
        const i = lower.indexOf(w)
        if (i < 0) return
        if (i < first) {
          first = i
          firstLen = w.length
        }
      }
      out.push({ ...h, flat, index: first, matchLen: firstLen })
    }
    // 현재 대화
    for (const it of p.current.items) {
      if (it.type !== 'user' && it.type !== 'assistant') continue
      consider({ key: `cur-${it.id}`, kind: 'chat', sessionId: p.currentSessionId, title: p.current.title, when: Date.now(), cwd: p.cwd, role: it.type === 'user' ? '나' : 'Claude', text: it.text })
    }
    // 저장된 세션
    for (const s of p.sessions) {
      if (s.id === p.currentSessionId) continue
      if (onlyHere && normPath(s.cwd) !== normPath(p.cwd)) continue
      const c = cache.get(s.id)
      if (!c) continue
      for (const it of c.items) {
        if (it.type !== 'user' && it.type !== 'assistant') continue
        consider({ key: `${s.id}-${it.id}`, kind: 'chat', sessionId: s.id, title: s.title, when: s.updatedAt, cwd: s.cwd, role: it.type === 'user' ? '나' : 'Claude', text: it.text })
      }
    }
    // 팀 작업 지시와 보고서
    for (const t of p.tasks) {
      if (onlyHere && normPath(t.cwd) !== normPath(p.cwd)) continue
      const e = p.employees.find((x) => x.id === t.employeeId)
      const who = e ? `${e.emoji} ${e.name}` : '직원'
      consider({ key: `task-${t.id}`, kind: 'task', taskId: t.id, title: t.title, when: t.createdAt, cwd: t.cwd, role: `지시 → ${who}`, text: `${t.title}\n${t.instructions}` })
      if (t.report) consider({ key: `report-${t.id}`, kind: 'report', taskId: t.id, title: t.title, when: t.finishedAt ?? t.createdAt, cwd: t.cwd, role: `${who} 보고서`, text: t.report })
    }
    out.sort((a, b) => b.when - a.when)
    return out.slice(0, 150)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wordsKey, onlyHere, version, p.sessions, p.tasks, p.employees, p.current.items, p.currentSessionId, p.cwd])

  const snippet = (h: SearchHit): ReactElement => {
    const start = Math.max(0, h.index - 90)
    const end = Math.min(h.flat.length, h.index + h.matchLen + 170)
    return (
      <div className="search-snippet">
        {start > 0 ? '…' : ''}
        {h.flat.slice(start, h.index)}
        <mark>{h.flat.slice(h.index, h.index + h.matchLen)}</mark>
        {h.flat.slice(h.index + h.matchLen, end)}
        {end < h.flat.length ? '…' : ''}
      </div>
    )
  }
  const KIND: Record<SearchHit['kind'], string> = { chat: '대화', task: '작업', report: '보고서' }

  return (
    <div className="modal-backdrop" onClick={p.onClose}>
      <div className="modal search" onClick={(e) => e.stopPropagation()}>
        <div className="search-head">
          <input
            ref={inputRef}
            className="text"
            placeholder="대화·보고서 내용 검색 (여러 단어는 모두 포함)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') p.onClose()
            }}
          />
          <label className="small" style={{ whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={onlyHere} onChange={(e) => setOnlyHere(e.target.checked)} /> 이 폴더만
          </label>
          <button className="ghost" onClick={p.onClose}>
            ✕
          </button>
        </div>
        <div className="muted small">
          {!canLoad
            ? '저장된 세션 검색은 Firebase 로그인 뒤에 가능합니다. 지금은 현재 대화와 팀 작업·보고서만 검색합니다.'
            : loading
              ? `세션 본문 불러오는 중 ${loaded}/${p.sessions.length}…`
              : `세션 ${p.sessions.length}개 · 팀 작업 ${p.tasks.length}개 · 현재 대화 포함`}
          {words.length > 0 && ` · 결과 ${hits.length}${hits.length >= 150 ? '+' : ''}건`}
          {' · Ctrl+K 로 열고 닫기'}
        </div>
        <div className="search-results">
          {words.length === 0 && (
            <div className="muted small" style={{ padding: 12 }}>
              검색어를 입력하세요. 결과의 <b>참조</b>를 누르면 그 내용이 인용 블록으로 입력창에 들어가고, 이어서 질문을 적어 보내면
              됩니다.
            </div>
          )}
          {words.length > 0 && hits.length === 0 && (
            <div className="muted small" style={{ padding: 12 }}>
              {loading ? '불러오는 중입니다…' : '일치하는 내용이 없습니다.'}
            </div>
          )}
          {hits.map((h) => (
            <div key={h.key} className="search-hit">
              <div className="search-hit-head">
                <span className="kind-badge">{KIND[h.kind]}</span>
                <b>{h.title || '(제목 없음)'}</b>
                <span>{h.role}</span>
                <span>{new Date(h.when).toLocaleDateString('ko-KR')}</span>
                <span className="mono" title={h.cwd}>
                  {h.cwd.length > 32 ? '…' + h.cwd.slice(-32) : h.cwd}
                </span>
              </div>
              {snippet(h)}
              <div className="search-actions">
                <button className="small-btn primary" onClick={() => p.onReference(referenceText(h))} title="인용 블록으로 입력창에 넣기">
                  참조
                </button>
                {h.kind === 'chat' && h.sessionId && h.sessionId !== p.currentSessionId && (
                  <button className="small-btn" onClick={() => p.onOpenSession(h.sessionId!)}>
                    세션 열기
                  </button>
                )}
                {h.taskId && (
                  <button className="small-btn" onClick={() => p.onOpenTask(h.taskId!)}>
                    작업 열기
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
