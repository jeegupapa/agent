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
  internal_review: '내부 검토',
  waiting_team: '팀 대기',
  approved: '승인됨',
  changes_requested: '수정 중',
  failed: '실패',
  stopped: '중단됨'
}

/** 지금 Claude 세션이 돌고 있는 상태 */
export function isActive(status: TeamTask['status']): boolean {
  return status === 'running' || status === 'waiting_permission' || status === 'changes_requested'
}

/** 실행이 끝나 더 진행되지 않는 상태 (맡긴 쪽에서 보고를 받아 갈 수 있다) */
export function isSettled(status: TeamTask['status']): boolean {
  return status === 'needs_review' || status === 'internal_review' || status === 'approved' || status === 'failed' || status === 'stopped'
}

/** 이 작업을 맡긴(또는 문의한) 직원의 작업 id. 사용자가 직접 맡긴 작업이면 undefined */
export function parentOf(t: Pick<TeamTask, 'origin'>): string | undefined {
  return t.origin?.kind === 'delegate' || t.origin?.kind === 'ask' ? t.origin.parentTaskId : undefined
}

/** 동료의 문의에 답하는 작업인지 */
export function isAsk(t: Pick<TeamTask, 'origin'>): boolean {
  return t.origin?.kind === 'ask'
}

/** 맡기기 깊이: 사용자가 직접 맡긴 작업은 0, 그 작업이 맡긴 작업은 1 … */
export function depthOf(t: TeamTask, tasks: TeamTask[]): number {
  let depth = 0
  let cur: TeamTask | undefined = t
  const seen = new Set<string>()
  while (cur) {
    const pid = parentOf(cur)
    if (!pid || seen.has(pid)) break
    seen.add(pid)
    depth++
    cur = tasks.find((x) => x.id === pid)
  }
  return depth
}

/** 사용자가 확인해야 하는 작업인지: 사용자의 검토 요청, 권한 승인 대기, 그리고 사용자가 직접 맡긴 작업의 실패 */
export function needsUser(t: TeamTask): boolean {
  return t.status === 'needs_review' || t.status === 'waiting_permission' || (t.status === 'failed' && !parentOf(t))
}
