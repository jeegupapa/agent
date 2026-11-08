import { useState } from 'react'
import type { ToolCallRecord } from '../../../shared/types'
import { toolIcon, toolSummary } from './ToolChip'
import { Markdown } from './Markdown'

function fmtTok(n?: number): string {
  if (!n) return '0'
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
}

interface Props {
  calls: ToolCallRecord[]
  selected: string | null
  onSelect: (id: string) => void
}

/** 호출 목록을 "최상위 → 그 아래 서브에이전트 도구들" 순서의 트리로 펼친다 */
function flatten(calls: ToolCallRecord[]): { call: ToolCallRecord; depth: number; children: number }[] {
  const byParent = new Map<string | undefined, ToolCallRecord[]>()
  for (const c of calls) {
    const key = c.parentId && calls.some((p) => p.id === c.parentId) ? c.parentId : undefined
    const list = byParent.get(key) ?? []
    list.push(c)
    byParent.set(key, list)
  }
  const out: { call: ToolCallRecord; depth: number; children: number }[] = []
  const walk = (parent: string | undefined, depth: number): void => {
    for (const c of byParent.get(parent) ?? []) {
      const kids = byParent.get(c.id) ?? []
      out.push({ call: c, depth, children: kids.length })
      walk(c.id, depth + 1)
    }
  }
  walk(undefined, 0)
  return out
}

export function ToolLog(p: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const sel = p.calls.find((c) => c.id === p.selected) ?? null
  const rows = flatten(p.calls)
  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  // 접힌 부모 아래의 행은 숨긴다
  const hidden = new Set<string>()
  for (const r of rows) {
    if (r.call.parentId && (collapsed.has(r.call.parentId) || hidden.has(r.call.parentId))) hidden.add(r.call.id)
  }

  let idx = 0
  return (
    <div className="tool-log">
      <ul className="tool-list">
        {p.calls.length === 0 && <li className="muted">아직 도구 호출이 없습니다.</li>}
        {rows.map((r) => {
          const c = r.call
          if (hidden.has(c.id)) return null
          const n = r.depth === 0 ? ++idx : 0
          return (
            <li
              key={c.id}
              className={`tool-row ${c.status} ${r.depth > 0 ? 'child' : ''} ${c.id === p.selected ? 'selected' : ''}`}
              style={r.depth > 1 ? { paddingLeft: 26 + (r.depth - 1) * 16 } : undefined}
              onClick={() => p.onSelect(c.id)}
            >
              <span className="idx">{r.depth === 0 ? n : '↳'}</span>
              <span className="icon">{toolIcon(c.name)}</span>
              <span className="name">{c.name}</span>
              <span className="summary">{toolSummary(c)}</span>
              {r.children > 0 && (
                <>
                  <span className="badge">도구 {r.children}</span>
                  <button
                    className="toggle"
                    title={collapsed.has(c.id) ? '펼치기' : '접기'}
                    onClick={(e) => {
                      e.stopPropagation()
                      toggle(c.id)
                    }}
                  >
                    {collapsed.has(c.id) ? '▸' : '▾'}
                  </button>
                </>
              )}
              <span className="dur">
                {c.finishedAt ? `${((c.finishedAt - c.startedAt) / 1000).toFixed(1)}s` : '…'}
              </span>
            </li>
          )
        })}
      </ul>

      {sel && (
        <div className="tool-detail">
          <h3>
            {toolIcon(sel.name)} {sel.name}
            <span className={`state ${sel.status}`}>{sel.status}</span>
            {sel.parentId && (
              <span className="muted small" style={{ marginLeft: 8 }}>
                서브에이전트: {p.calls.find((c) => c.id === sel.parentId)?.input.description as string | undefined}
              </span>
            )}
          </h3>
          <h4>입력</h4>
          <pre>{JSON.stringify(sel.input, null, 2)}</pre>
          {sel.subagent && (
            <div className="sub-output">
              <div className="sub-head">
                <b>서브에이전트</b>
                {sel.subagent.subagentType && <span className="badge">{sel.subagent.subagentType}</span>}
                <span className={`state ${sel.subagent.status ?? 'running'}`}>
                  {sel.subagent.status === 'completed'
                    ? '완료'
                    : sel.subagent.status === 'failed'
                      ? '실패'
                      : sel.subagent.status === 'stopped'
                        ? '중단'
                        : '진행 중'}
                </span>
                <span className="muted small">
                  도구 {sel.subagent.toolUses ?? p.calls.filter((c) => c.parentId === sel.id).length}회 · 토큰{' '}
                  {fmtTok(sel.subagent.totalTokens)}
                  {sel.subagent.durationMs ? ` · ${(sel.subagent.durationMs / 1000).toFixed(0)}s` : ''}
                  {sel.subagent.lastTool && sel.subagent.status !== 'completed' ? ` · 마지막: ${sel.subagent.lastTool}` : ''}
                </span>
              </div>
              {sel.subagent.summary && (
                <div className="bubble md sub-output-body">
                  <Markdown text={sel.subagent.summary} />
                </div>
              )}
              {sel.subagent.prompt && (
                <details>
                  <summary>지시문 ({sel.subagent.prompt.length.toLocaleString()}자)</summary>
                  <pre>{sel.subagent.prompt}</pre>
                </details>
              )}
            </div>
          )}
          <h4>결과</h4>
          <pre className={sel.isError ? 'error' : ''}>
            {sel.result ?? (sel.status === 'running' ? '(실행 중…)' : '(없음)')}
          </pre>
        </div>
      )}
    </div>
  )
}
