import { useEffect, useState } from 'react'
import { diffLines } from 'diff'
import type { ToolCallRecord } from '../../../shared/types'

interface Props {
  calls: ToolCallRecord[]
  selected: string | null
  onSelect: (id: string) => void
}

interface FileChange {
  callId: string
  file: string
  tool: string
  /** 도구 입력에서 뽑은 변경 부분 (old_string → new_string 등) */
  before: string
  after: string
  /** 실행 전후 파일 스냅샷 (메인 프로세스가 읽음). 없으면 undefined */
  fileBefore?: string
  fileAfter?: string
  status: ToolCallRecord['status']
}

/** Edit / Write / MultiEdit 호출을 "이전 → 이후" 텍스트 쌍으로 변환한다. */
export function toFileChanges(calls: ToolCallRecord[]): FileChange[] {
  const out: FileChange[] = []
  for (const c of calls) {
    const i = c.input
    const file = String(i.file_path ?? i.notebook_path ?? '')
    const base = { callId: c.id, file, tool: c.name, fileBefore: c.fileBefore, fileAfter: c.fileAfter, status: c.status }
    if (c.name === 'Edit') {
      out.push({ ...base, before: String(i.old_string ?? ''), after: String(i.new_string ?? '') })
    } else if (c.name === 'Write') {
      out.push({ ...base, before: '', after: String(i.content ?? '') })
    } else if (c.name === 'MultiEdit' && Array.isArray(i.edits)) {
      const edits = i.edits as { old_string?: string; new_string?: string }[]
      out.push({
        ...base,
        before: edits.map((e) => e.old_string ?? '').join('\n…\n'),
        after: edits.map((e) => e.new_string ?? '').join('\n…\n')
      })
    } else if (c.name === 'NotebookEdit') {
      out.push({ ...base, before: '', after: String(i.new_source ?? '') })
    }
  }
  return out
}

type Row =
  | { kind: 'line'; cls: 'add' | 'del' | 'ctx'; o: string; n: string; text: string }
  | { kind: 'fold'; from: number; count: number }

/** diffLines 결과를 행으로 펼친다. context 가 주어지면 변경 주변 n줄만 남기고 나머지는 fold 행으로 접는다 */
function buildRows(before: string, after: string, context: number | null): { rows: Row[]; adds: number; dels: number } {
  const parts = diffLines(before, after)
  const all: Row[] = []
  let oldLine = 1
  let newLine = 1
  let adds = 0
  let dels = 0
  for (const part of parts) {
    const lines = part.value.replace(/\n$/, '').split('\n')
    if (part.value === '') continue
    for (const line of lines) {
      const cls = part.added ? 'add' : part.removed ? 'del' : 'ctx'
      if (part.added) adds++
      if (part.removed) dels++
      all.push({
        kind: 'line',
        cls,
        o: part.added ? '' : String(oldLine++),
        n: part.removed ? '' : String(newLine++),
        text: line
      })
    }
  }
  if (context === null) return { rows: all, adds, dels }

  // 변경 행에서 context 줄 이내인 행만 보이게 표시
  const keep = new Array<boolean>(all.length).fill(false)
  all.forEach((r, i) => {
    if (r.kind === 'line' && r.cls !== 'ctx') {
      for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j++) keep[j] = true
    }
  })
  const rows: Row[] = []
  let i = 0
  while (i < all.length) {
    if (keep[i]) {
      rows.push(all[i])
      i++
    } else {
      let j = i
      while (j < all.length && !keep[j]) j++
      rows.push({ kind: 'fold', from: i, count: j - i })
      i = j
    }
  }
  return { rows, adds, dels }
}

export function DiffView({
  before,
  after,
  context = null
}: {
  before: string
  after: string
  /** null 이면 전부 표시, 숫자면 변경 주변 n줄만 */
  context?: number | null
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  useEffect(() => setExpanded(new Set()), [before, after, context])
  const { rows } = buildRows(before, after, context)
  const full = context === null ? null : buildRows(before, after, null).rows

  return (
    <pre className="diff">
      {rows.map((r, idx) => {
        if (r.kind === 'fold') {
          if (expanded.has(r.from) && full) {
            return full.slice(r.from, r.from + r.count).map((l, li) =>
              l.kind === 'line' ? (
                <div key={`${idx}-${li}`} className={`diff-line ${l.cls}`}>
                  <span className="ln">{l.o}</span>
                  <span className="ln">{l.n}</span>
                  <span className="sign"> </span>
                  <span className="code">{l.text}</span>
                </div>
              ) : null
            )
          }
          return (
            <div
              key={idx}
              className="diff-line fold"
              onClick={() => setExpanded((prev) => new Set(prev).add(r.from))}
              title="클릭하면 펼칩니다"
            >
              <span className="ln" />
              <span className="ln" />
              <span className="sign">…</span>
              <span className="code">{r.count}줄 생략 (펼치기)</span>
            </div>
          )
        }
        return (
          <div key={idx} className={`diff-line ${r.cls}`}>
            <span className="ln">{r.o}</span>
            <span className="ln">{r.n}</span>
            <span className="sign">{r.cls === 'add' ? '+' : r.cls === 'del' ? '-' : ' '}</span>
            <span className="code">{r.text}</span>
          </div>
        )
      })}
    </pre>
  )
}

type Mode = 'file' | 'input'

export function DiffPanel(p: Props) {
  const changes = toFileChanges(p.calls)
  const sel = changes.find((c) => c.callId === p.selected) ?? changes[changes.length - 1] ?? null
  const [mode, setMode] = useState<Mode>('file')

  // 파일별 변경 횟수
  const byFile = new Map<string, number>()
  for (const c of changes) byFile.set(c.file, (byFile.get(c.file) ?? 0) + 1)

  const hasSnapshot = !!sel && sel.fileBefore !== undefined && sel.fileAfter !== undefined
  const effectiveMode: Mode = hasSnapshot ? mode : 'input'
  const stat = sel && hasSnapshot ? buildRows(sel.fileBefore!, sel.fileAfter!, null) : null

  return (
    <div className="diff-panel">
      <ul className="file-list">
        {changes.length === 0 && <li className="muted">아직 파일 변경이 없습니다.</li>}
        {changes.map((c, idx) => (
          <li
            key={c.callId}
            className={sel?.callId === c.callId ? 'selected' : ''}
            onClick={() => p.onSelect(c.callId)}
            title={c.file}
          >
            <span className="idx">{idx + 1}</span>
            <span className="tool">{c.tool}</span>
            <span className="file">{c.file.split(/[\\/]/).pop()}</span>
            {(byFile.get(c.file) ?? 0) > 1 && <span className="badge">×{byFile.get(c.file)}</span>}
            {c.status === 'denied' && <span className="badge">거부</span>}
            {c.status === 'error' && <span className="badge">오류</span>}
          </li>
        ))}
      </ul>
      {sel && (
        <div className="diff-body">
          <div className="diff-head">
            <b>{sel.tool}</b> <span className="mono">{sel.file}</span>
            <span className="spacer" />
            {stat && (
              <span className="diff-stat">
                <span className="add">+{stat.adds}</span> <span className="del">-{stat.dels}</span>
              </span>
            )}
            <span className="seg">
              <button
                className={effectiveMode === 'file' ? 'active' : ''}
                disabled={!hasSnapshot}
                title={hasSnapshot ? '실행 전후 파일 전체를 비교' : '파일 스냅샷이 없습니다 (실행 중이거나 파일이 너무 큼)'}
                onClick={() => setMode('file')}
              >
                전체 파일
              </button>
              <button className={effectiveMode === 'input' ? 'active' : ''} onClick={() => setMode('input')}>
                변경 부분
              </button>
            </span>
          </div>
          {effectiveMode === 'file' ? (
            stat && stat.adds === 0 && stat.dels === 0 ? (
              <div className="muted small" style={{ padding: 8 }}>
                실행 전후 파일 내용이 같습니다{sel.status === 'denied' ? ' (거부됨)' : sel.status === 'error' ? ' (오류)' : ''}.
              </div>
            ) : (
              <DiffView before={sel.fileBefore!} after={sel.fileAfter!} context={3} />
            )
          ) : (
            <DiffView before={sel.before} after={sel.after} />
          )}
        </div>
      )}
    </div>
  )
}
