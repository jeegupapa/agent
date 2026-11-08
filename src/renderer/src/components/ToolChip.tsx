import type { ToolCallRecord } from '../../../shared/types'

export function toolSummary(call: ToolCallRecord): string {
  const i = call.input
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  switch (call.name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return s(i.file_path) || s(i.notebook_path)
    case 'Bash':
    case 'PowerShell':
      return s(i.description) || s(i.command).slice(0, 80)
    case 'Glob':
      return s(i.pattern)
    case 'Grep':
      return s(i.pattern)
    case 'WebFetch':
      return s(i.url)
    case 'WebSearch':
      return s(i.query)
    case 'Task':
    case 'Agent':
      return s(i.description)
    default: {
      const first = Object.values(i).find((v) => typeof v === 'string') as string | undefined
      return first ? first.slice(0, 80) : ''
    }
  }
}

export function toolIcon(name: string): string {
  switch (name) {
    case 'Read':
      return '📄'
    case 'Write':
      return '📝'
    case 'Edit':
    case 'MultiEdit':
      return '✏️'
    case 'Bash':
    case 'PowerShell':
      return '💻'
    case 'Glob':
    case 'Grep':
      return '🔍'
    case 'WebFetch':
    case 'WebSearch':
      return '🌐'
    case 'Task':
    case 'Agent':
      return '🤖'
    default:
      return '🔧'
  }
}

export function ToolChip({
  call,
  childCount = 0,
  onClick
}: {
  call: ToolCallRecord
  /** 서브에이전트가 실행한 하위 도구 수 */
  childCount?: number
  onClick?: () => void
}) {
  return (
    <button className={`tool-chip ${call.status}`} onClick={onClick} title={JSON.stringify(call.input, null, 2)}>
      <span className="icon">{toolIcon(call.name)}</span>
      <span className="name">{call.name}</span>
      <span className="summary">{toolSummary(call)}</span>
      {(call.subagent?.toolUses ?? childCount) > 0 && (
        <span className="badge">도구 {call.subagent?.toolUses ?? childCount}</span>
      )}
      {call.status === 'running' && call.subagent?.lastTool && (
        <span className="badge">{call.subagent.lastTool}</span>
      )}
      <span className={`state ${call.status}`}>
        {call.status === 'running' ? '실행 중' : call.status === 'done' ? '완료' : call.status === 'denied' ? '거부됨' : '오류'}
      </span>
    </button>
  )
}
