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
  before: string
  after: string
}

/** Edit / Write / MultiEdit 호출을 "이전 → 이후" 텍스트 쌍으로 변환한다. */
export function toFileChanges(calls: ToolCallRecord[]): FileChange[] {
  const out: FileChange[] = []
  for (const c of calls) {
    const i = c.input
    const file = String(i.file_path ?? i.notebook_path ?? '')
    if (c.name === 'Edit') {
      out.push({ callId: c.id, file, tool: c.name, before: String(i.old_string ?? ''), after: String(i.new_string ?? '') })
    } else if (c.name === 'Write') {
      out.push({ callId: c.id, file, tool: c.name, before: '', after: String(i.content ?? '') })
    } else if (c.name === 'MultiEdit' && Array.isArray(i.edits)) {
      const edits = i.edits as { old_string?: string; new_string?: string }[]
      out.push({
        callId: c.id,
        file,
        tool: c.name,
        before: edits.map((e) => e.old_string ?? '').join('\n…\n'),
        after: edits.map((e) => e.new_string ?? '').join('\n…\n')
      })
    } else if (c.name === 'NotebookEdit') {
      out.push({ callId: c.id, file, tool: c.name, before: '', after: String(i.new_source ?? '') })
    }
  }
  return out
}

export function DiffView({ before, after }: { before: string; after: string }) {
  const parts = diffLines(before, after)
  let oldLine = 1
  let newLine = 1
  return (
    <pre className="diff">
      {parts.map((part, idx) => {
        const lines = part.value.replace(/\n$/, '').split('\n')
        return lines.map((line, li) => {
          const cls = part.added ? 'add' : part.removed ? 'del' : 'ctx'
          const o = part.added ? '' : String(oldLine++)
          const n = part.removed ? '' : String(newLine++)
          return (
            <div key={`${idx}-${li}`} className={`diff-line ${cls}`}>
              <span className="ln">{o}</span>
              <span className="ln">{n}</span>
              <span className="sign">{part.added ? '+' : part.removed ? '-' : ' '}</span>
              <span className="code">{line}</span>
            </div>
          )
        })
      })}
    </pre>
  )
}

export function DiffPanel(p: Props) {
  const changes = toFileChanges(p.calls)
  const sel = changes.find((c) => c.callId === p.selected) ?? changes[changes.length - 1] ?? null

  // 파일별 변경 횟수
  const byFile = new Map<string, number>()
  for (const c of changes) byFile.set(c.file, (byFile.get(c.file) ?? 0) + 1)

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
          </li>
        ))}
      </ul>
      {sel && (
        <div className="diff-body">
          <div className="diff-head">
            <b>{sel.tool}</b> <span className="mono">{sel.file}</span>
          </div>
          <DiffView before={sel.before} after={sel.after} />
        </div>
      )}
    </div>
  )
}
