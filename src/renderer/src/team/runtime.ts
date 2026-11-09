// 팀 작업의 실시간 상태: 이벤트 → 트랜스크립트(items/toolCalls) 와 작업 진행 정보 갱신
import type { ClaudeEvent, TeamTask, ToolCallRecord } from '../../../shared/types'
import type { ChatItem } from '../components/Chat'

export interface TaskRuntime {
  items: ChatItem[]
  toolCalls: ToolCallRecord[]
  /** 스트리밍 중인 어시스턴트 항목 id */
  streamingId: string | null
  /** 마지막으로 완성된 어시스턴트 텍스트 (보고서 후보) */
  lastAssistantText: string
}

export const EMPTY_RUNTIME: TaskRuntime = { items: [], toolCalls: [], streamingId: null, lastAssistantText: '' }

/** 이벤트를 런타임 트랜스크립트에 반영한다 (불변) */
export function applyEvent(rt: TaskRuntime, ev: ClaudeEvent): TaskRuntime {
  switch (ev.kind) {
    case 'text_delta': {
      if (rt.streamingId) {
        return {
          ...rt,
          items: rt.items.map((it) =>
            it.id === rt.streamingId && it.type === 'assistant' ? { ...it, text: it.text + ev.text } : it
          )
        }
      }
      const id = `a-${Date.now()}-${Math.random()}`
      return { ...rt, streamingId: id, items: [...rt.items, { id, type: 'assistant', text: ev.text, streaming: true }] }
    }
    case 'text_done':
      return {
        ...rt,
        streamingId: null,
        lastAssistantText: ev.text || rt.lastAssistantText,
        items: rt.items.map((it) =>
          it.id === rt.streamingId && it.type === 'assistant' ? { ...it, streaming: false } : it
        )
      }
    case 'tool_start': {
      const items = ev.call.parentId
        ? rt.items
        : [...rt.items, { id: ev.call.id, type: 'tool' as const, callId: ev.call.id }]
      return { ...rt, items, toolCalls: [...rt.toolCalls, ev.call] }
    }
    case 'tool_result':
      return {
        ...rt,
        toolCalls: rt.toolCalls.map((c) =>
          c.id === ev.id
            ? {
                ...c,
                status: ev.isError ? 'error' : 'done',
                result: ev.result,
                isError: ev.isError,
                fileAfter: ev.fileAfter,
                finishedAt: Date.now()
              }
            : c
        )
      }
    case 'subagent_info':
      return {
        ...rt,
        toolCalls: rt.toolCalls.map((c) => {
          if (c.id !== ev.parentId) return c
          const patch = Object.fromEntries(Object.entries(ev.info).filter(([, v]) => v !== undefined))
          return { ...c, subagent: { ...(c.subagent ?? {}), ...patch } }
        })
      }
    case 'error':
      return {
        ...rt,
        streamingId: null,
        items: [...rt.items, { id: `e-${Date.now()}`, type: 'system', text: ev.message, isError: true }]
      }
    case 'result':
      if (ev.isError && ev.errorText) {
        return {
          ...rt,
          streamingId: null,
          items: [...rt.items, { id: `e-${Date.now()}`, type: 'system', text: ev.errorText, isError: true }]
        }
      }
      return { ...rt, streamingId: null }
    default:
      return rt
  }
}

/** 보고서 본문: 마지막 어시스턴트 메시지에서 "## 보고" 이후만, 없으면 전체 */
export function extractReport(text: string): string {
  const i = text.lastIndexOf('## 보고')
  return (i >= 0 ? text.slice(i) : text).trim()
}

/** 이벤트로부터 작업 레코드에 반영할 변경 (진행·상태·보고) */
export function deriveTaskPatch(task: TeamTask, ev: ClaudeEvent, rt: TaskRuntime): Partial<TeamTask> | null {
  const now = Date.now()
  switch (ev.kind) {
    case 'session':
      return { sessionId: ev.info.sessionId }
    case 'tool_start':
      if (ev.call.parentId) return null
      return {
        status: task.status === 'waiting_permission' ? 'running' : task.status,
        progress: { ...task.progress, toolUses: task.progress.toolUses + 1, lastTool: ev.call.name, updatedAt: now }
      }
    case 'text_done':
      return { progress: { ...task.progress, lastText: ev.text.slice(-240), updatedAt: now } }
    case 'result': {
      const report = extractReport(rt.lastAssistantText)
      // 사용자가 중단한 작업은 뒤따라 오는 종료 이벤트 때문에 "실패"로 바뀌지 않게 한다
      const stopped = task.status === 'stopped'
      return {
        status: stopped ? 'stopped' : ev.isError ? 'failed' : 'needs_review',
        finishedAt: now,
        sessionId: ev.sessionId,
        error: ev.isError && !stopped ? (ev.errorText ?? '실행 오류') : undefined,
        report: ev.isError ? task.report : report || task.report,
        progress: {
          ...task.progress,
          numTurns: ev.usage.numTurns,
          totalTokens: (task.progress.totalTokens ?? 0) + ev.usage.inputTokens + ev.usage.outputTokens,
          costUsd: ev.usage.totalCostUsd,
          updatedAt: now
        }
      }
    }
    case 'error':
      if (task.status === 'stopped') return null
      return { status: 'failed', finishedAt: now, error: ev.message }
    default:
      return null
  }
}

export const STATUS_LABEL: Record<TeamTask['status'], string> = {
  queued: '대기',
  running: '작업 중',
  waiting_permission: '승인 필요',
  needs_review: '검토 요청',
  approved: '승인됨',
  changes_requested: '수정 중',
  failed: '실패',
  stopped: '중단됨'
}

export function isActive(status: TeamTask['status']): boolean {
  return status === 'running' || status === 'waiting_permission' || status === 'changes_requested'
}
