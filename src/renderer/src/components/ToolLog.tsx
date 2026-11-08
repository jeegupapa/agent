import type { ToolCallRecord } from '../../../shared/types'
import { toolIcon, toolSummary } from './ToolChip'

interface Props {
  calls: ToolCallRecord[]
  selected: string | null
  onSelect: (id: string) => void
}

export function ToolLog(p: Props) {
  const sel = p.calls.find((c) => c.id === p.selected) ?? null

  return (
    <div className="tool-log">
      <ul className="tool-list">
        {p.calls.length === 0 && <li className="muted">아직 도구 호출이 없습니다.</li>}
        {p.calls.map((c, idx) => (
          <li
            key={c.id}
            className={`tool-row ${c.status} ${c.id === p.selected ? 'selected' : ''}`}
            onClick={() => p.onSelect(c.id)}
          >
            <span className="idx">{idx + 1}</span>
            <span className="icon">{toolIcon(c.name)}</span>
            <span className="name">{c.name}</span>
            <span className="summary">{toolSummary(c)}</span>
            <span className="dur">
              {c.finishedAt ? `${((c.finishedAt - c.startedAt) / 1000).toFixed(1)}s` : '…'}
            </span>
          </li>
        ))}
      </ul>

      {sel && (
        <div className="tool-detail">
          <h3>
            {toolIcon(sel.name)} {sel.name}
            <span className={`state ${sel.status}`}>{sel.status}</span>
          </h3>
          <h4>입력</h4>
          <pre>{JSON.stringify(sel.input, null, 2)}</pre>
          <h4>결과</h4>
          <pre className={sel.isError ? 'error' : ''}>
            {sel.result ?? (sel.status === 'running' ? '(실행 중…)' : '(없음)')}
          </pre>
        </div>
      )}
    </div>
  )
}
