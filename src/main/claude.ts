import {
  query,
  type McpServerConfig,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage
} from '@anthropic-ai/claude-agent-sdk'
import type { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { readFileSync, statSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import type {
  AppConfig,
  ClaudeEvent,
  PermissionAnswer,
  PermissionRequest,
  PlanWindow,
  SendPromptArgs,
  SubagentInfo,
  ToolCallRecord
} from '../shared/types'

/** 초 단위 epoch 를 밀리초로. 이미 밀리초면 그대로. */
function toMillis(t?: number): number | undefined {
  if (t === undefined || t === null) return undefined
  return t < 1e12 ? t * 1000 : t
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_SNAPSHOT_BYTES = 1_000_000

/** Edit/Write 계열 도구가 건드리는 파일 경로 */
function editTargetPath(name: string, input: Record<string, unknown>, cwd: string): string | null {
  if (!EDIT_TOOLS.has(name)) return null
  const p = input.file_path ?? input.notebook_path
  if (typeof p !== 'string' || !p) return null
  return isAbsolute(p) ? p : resolve(cwd, p)
}

/** 파일 내용 스냅샷. 없으면 빈 문자열, 너무 크거나 바이너리면 undefined */
function snapshot(path: string): string | undefined {
  try {
    if (statSync(path).size > MAX_SNAPSHOT_BYTES) return undefined
  } catch {
    return ''
  }
  try {
    const buf = readFileSync(path)
    if (buf.includes(0)) return undefined
    return buf.toString('utf8')
  } catch {
    return undefined
  }
}

/** 앱 설정의 MCP 항목을 SDK 가 받는 형태로 변환 (켜진 것만) */
export function toSdkMcpServers(config: AppConfig): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const s of config.mcpServers) {
    if (!s.enabled || !s.name.trim()) continue
    if (s.type === 'stdio') {
      if (!s.command) continue
      out[s.name] = { type: 'stdio', command: s.command, args: s.args ?? [], env: s.env }
    } else {
      if (!s.url) continue
      out[s.name] = { type: s.type, url: s.url, headers: s.headers }
    }
  }
  return out
}

/** 인증 모드에 맞춰 자식 프로세스 환경 변수를 구성 */
export function buildEnv(config: AppConfig, apiKey: string | null): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  if (config.auth.mode === 'apiKey' && apiKey) {
    env.ANTHROPIC_API_KEY = apiKey
  } else {
    // claude.ai 로그인으로 쓰려면 상속된 API 키가 끼어들지 않게 제거
    delete env.ANTHROPIC_API_KEY
    delete env.ANTHROPIC_AUTH_TOKEN
  }
  if (config.auth.baseUrl?.trim()) env.ANTHROPIC_BASE_URL = config.auth.baseUrl.trim()
  else delete env.ANTHROPIC_BASE_URL
  return env
}

/** 이벤트와 권한 요청을 어디로 보낼지. 기본은 메인 채팅 채널, 팀 작업은 taskId 를 붙여 다른 채널로 보낸다 */
export interface RunnerSink {
  emit(event: ClaudeEvent): void
  requestPermission(req: PermissionRequest): void
}

export function windowSink(win: BrowserWindow): RunnerSink {
  return {
    emit: (event) => {
      if (!win.isDestroyed()) win.webContents.send('claude:event', event)
    },
    requestPermission: (req) => {
      if (!win.isDestroyed()) win.webContents.send('claude:permission', req)
    }
  }
}

/**
 * Agent SDK의 query()를 감싸서 렌더러가 그리기 쉬운 ClaudeEvent 스트림으로 바꿔준다.
 * - 텍스트는 stream_event 로 글자 단위로 흘려보내고
 * - tool_use / tool_result 는 ToolCallRecord 로 묶어서 보낸다
 * - 권한 요청(canUseTool)은 렌더러에 물어보고 답을 기다린다
 */
export class ClaudeRunner {
  private current: Query | null = null
  private pendingPermissions = new Map<string, (answer: PermissionAnswer) => void>()
  /** 실행 중인 Edit/Write 호출 id → 대상 파일 경로 (완료 후 스냅샷용) */
  private editTargets = new Map<string, string>()
  private cwd = ''
  /** 이미 tool_start 를 보낸 도구 id (stream_event 와 assistant 메시지 중복 방지) */
  private emittedTools = new Set<string>()

  private sink: RunnerSink

  constructor(
    win: BrowserWindow,
    private getConfig: () => { config: AppConfig; apiKey: string | null },
    sink?: RunnerSink
  ) {
    this.sink = sink ?? windowSink(win)
  }

  get isRunning(): boolean {
    return this.current !== null
  }

  /** 아직 답을 기다리는 권한 요청 id 가 있는지 */
  hasPendingPermission(requestId: string): boolean {
    return this.pendingPermissions.has(requestId)
  }

  private emit(event: ClaudeEvent): void {
    this.sink.emit(event)
  }

  answerPermission(answer: PermissionAnswer): void {
    const resolve = this.pendingPermissions.get(answer.requestId)
    if (resolve) {
      this.pendingPermissions.delete(answer.requestId)
      resolve(answer)
    }
  }

  async interrupt(): Promise<void> {
    if (this.current) {
      try {
        await this.current.interrupt()
      } catch {
        this.current.close()
      }
    }
  }

  async run(args: SendPromptArgs): Promise<void> {
    if (this.current) throw new Error('이미 실행 중인 요청이 있습니다.')
    const { config, apiKey } = this.getConfig()
    if (config.auth.mode === 'apiKey' && !apiKey) {
      throw new Error('API 키 모드인데 저장된 키가 없습니다. 연결 설정에서 키를 입력하세요.')
    }

    const options: Options = {
      cwd: args.cwd,
      resume: args.sessionId,
      permissionMode: args.permissionMode,
      includePartialMessages: true,
      env: buildEnv(config, apiKey),
      mcpServers: toSdkMcpServers(config),
      // 켜져 있으면 ~/.claude 와 프로젝트 .claude 의 설정·MCP·스킬·CLAUDE.md 를 CLI 처럼 읽는다
      settingSources: config.inheritSettings ? ['user', 'project', 'local'] : [],
      model: args.model?.trim() || config.model?.trim() || undefined,
      // 항상 Claude Code 기본 시스템 프롬프트를 쓰고, 그 뒤에 역할 지시문(직원)·사용자 메모리를 붙인다
      systemPrompt: { type: 'preset', preset: 'claude_code', append: args.systemPromptAppend?.trim() || undefined },
      allowedTools: args.allowedTools,
      disallowedTools: args.disallowedTools,
      maxTurns: args.maxTurns,
      // 서브에이전트 진행 상황을 task_progress.summary 로 받는다
      agentProgressSummaries: true,
      canUseTool: async (toolName, input, { signal, suggestions }): Promise<PermissionResult> => {
        const requestId = randomUUID()
        const answer = await new Promise<PermissionAnswer>((resolve) => {
          this.pendingPermissions.set(requestId, resolve)
          signal.addEventListener('abort', () => {
            this.pendingPermissions.delete(requestId)
            resolve({ requestId, allow: false })
          })
          this.sink.requestPermission({ requestId, toolName, input })
        })
        if (answer.allow) {
          return {
            behavior: 'allow',
            updatedInput: input,
            updatedPermissions: answer.always ? suggestions : undefined
          }
        }
        return { behavior: 'deny', message: '사용자가 거부했습니다.' }
      }
    }

    const q = query({ prompt: args.prompt, options })
    this.current = q
    this.cwd = args.cwd
    this.editTargets.clear()
    this.emittedTools.clear()

    // stream_event 에서 현재 조립 중인 블록을 추적한다. 키는 "부모 도구 id:블록 index"
    // (서브에이전트가 병렬로 돌면 index 가 겹치므로)
    let currentText = ''
    const openToolInputs = new Map<string, { id: string; name: string; json: string; parentId?: string }>()

    try {
      for await (const msg of q) {
        this.handleMessage(msg, {
          onText: (delta) => {
            currentText += delta
            this.emit({ kind: 'text_delta', text: delta })
          },
          onTextDone: () => {
            if (currentText) this.emit({ kind: 'text_done', text: currentText })
            currentText = ''
          },
          openToolInputs
        })
      }
    } catch (err) {
      this.emit({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      this.current = null
    }
  }

  /** tool_start 이벤트 발행 (+ 파일 편집 도구는 실행 직전 스냅샷) */
  private emitToolStart(id: string, name: string, input: Record<string, unknown>, parentId?: string): void {
    if (this.emittedTools.has(id)) return
    this.emittedTools.add(id)
    const call: ToolCallRecord = { id, name, input, status: 'running', startedAt: Date.now(), parentId }
    const target = editTargetPath(name, input, this.cwd)
    if (target) {
      this.editTargets.set(id, target)
      call.fileBefore = snapshot(target)
    }
    this.emit({ kind: 'tool_start', call })
  }

  private handleMessage(
    msg: SDKMessage,
    ctx: {
      onText: (delta: string) => void
      onTextDone: () => void
      openToolInputs: Map<string, { id: string; name: string; json: string; parentId?: string }>
    }
  ): void {
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          this.emit({
            kind: 'session',
            info: {
              sessionId: msg.session_id,
              cwd: msg.cwd,
              model: msg.model,
              tools: msg.tools,
              apiKeySource: msg.apiKeySource,
              mcpServers: msg.mcp_servers ?? [],
              slashCommands: msg.slash_commands ?? [],
              skills: msg.skills ?? [],
              plugins: msg.plugins ?? [],
              claudeCodeVersion: msg.claude_code_version
            }
          })
        } else if (msg.subtype === 'status') {
          const s = (msg as { status?: string | null }).status
          this.emit({ kind: 'status', text: s ? String(s) : '' })
        } else if (msg.subtype === 'task_started') {
          if (msg.tool_use_id && !msg.skip_transcript) {
            this.emit({
              kind: 'subagent_info',
              parentId: msg.tool_use_id,
              info: {
                description: msg.description,
                subagentType: msg.subagent_type,
                prompt: msg.prompt,
                status: 'running'
              }
            })
          }
        } else if (msg.subtype === 'task_progress') {
          if (msg.tool_use_id) {
            const info: SubagentInfo = {
              description: msg.description,
              subagentType: msg.subagent_type,
              lastTool: msg.last_tool_name,
              totalTokens: msg.usage?.total_tokens,
              toolUses: msg.usage?.tool_uses,
              durationMs: msg.usage?.duration_ms
            }
            if (msg.summary) info.summary = msg.summary
            this.emit({ kind: 'subagent_info', parentId: msg.tool_use_id, info })
          }
        } else if (msg.subtype === 'task_notification') {
          if (msg.tool_use_id && !msg.skip_transcript) {
            this.emit({
              kind: 'subagent_info',
              parentId: msg.tool_use_id,
              info: {
                status: msg.status,
                summary: msg.summary || undefined,
                totalTokens: msg.usage?.total_tokens,
                toolUses: msg.usage?.tool_uses,
                durationMs: msg.usage?.duration_ms
              }
            })
          }
        }
        break
      }
      case 'stream_event': {
        // 서브에이전트(Agent/Task) 안의 출력: 텍스트는 생략하고 도구 호출만 부모 id 를 붙여 기록한다
        const parentId = msg.parent_tool_use_id ?? undefined
        const ev = msg.event
        const key = `${parentId ?? ''}:${'index' in ev ? ev.index : -1}`
        if (ev.type === 'content_block_start') {
          const block = ev.content_block
          if (block.type === 'tool_use') {
            ctx.openToolInputs.set(key, { id: block.id, name: block.name, json: '', parentId })
          }
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta
          if (d.type === 'text_delta') {
            if (!parentId) ctx.onText(d.text)
          } else if (d.type === 'thinking_delta') {
            if (!parentId) this.emit({ kind: 'thinking_delta', text: d.thinking })
          } else if (d.type === 'input_json_delta') {
            const open = ctx.openToolInputs.get(key)
            if (open) open.json += d.partial_json
          }
        } else if (ev.type === 'content_block_stop') {
          const open = ctx.openToolInputs.get(key)
          if (open) {
            ctx.openToolInputs.delete(key)
            let input: Record<string, unknown> = {}
            try {
              input = open.json ? JSON.parse(open.json) : {}
            } catch {
              input = { _raw: open.json }
            }
            if (!parentId) ctx.onTextDone()
            this.emitToolStart(open.id, open.name, input, open.parentId)
          } else if (!parentId) {
            ctx.onTextDone()
          }
        }
        break
      }
      case 'assistant': {
        // 서브에이전트(Agent/Task) 안의 도구 호출은 stream_event 로 오지 않고 완성된 assistant 메시지로만 오므로
        // 여기서 parent_tool_use_id 를 붙여 기록한다. 메인 에이전트 것은 stream_event 에서 이미 처리했다.
        const parentId = msg.parent_tool_use_id ?? undefined
        if (!parentId) break
        const content = msg.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              this.emitToolStart(block.id, block.name, (block.input ?? {}) as Record<string, unknown>, parentId)
            }
          }
        }
        break
      }
      case 'user': {
        // tool_result 블록이 들어 있는 user 메시지
        const content = msg.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              const text =
                typeof block.content === 'string'
                  ? block.content
                  : Array.isArray(block.content)
                    ? block.content
                        .map((c) => (c.type === 'text' ? c.text : '[' + c.type + ']'))
                        .join('\n')
                    : ''
              const target = this.editTargets.get(block.tool_use_id)
              let fileAfter: string | undefined
              if (target) {
                this.editTargets.delete(block.tool_use_id)
                fileAfter = snapshot(target)
              }
              this.emit({
                kind: 'tool_result',
                id: block.tool_use_id,
                result: text,
                isError: block.is_error === true,
                fileAfter
              })
            }
          }
        }
        break
      }
      case 'rate_limit_event': {
        // 구독(claude.ai) 사용자의 플랜 한도. unifiedWindows 에 창별 정보가 들어오고,
        // 없으면 최상위 필드 하나만 있다.
        const info = msg.rate_limit_info as typeof msg.rate_limit_info & {
          unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number; status?: string }>
        }
        const windows: PlanWindow[] = []
        if (info.unifiedWindows) {
          for (const [type, w] of Object.entries(info.unifiedWindows)) {
            windows.push({
              type,
              status: (w.status as PlanWindow['status']) ?? 'allowed',
              utilization: w.utilization ?? 0,
              resetsAt: toMillis(w.resetsAt)
            })
          }
        } else if (info.rateLimitType) {
          windows.push({
            type: info.rateLimitType,
            status: info.status,
            utilization: info.utilization ?? 0,
            resetsAt: toMillis(info.resetsAt)
          })
        }
        this.emit({
          kind: 'rate_limit',
          windows,
          isUsingOverage: info.isUsingOverage === true || info.overageInUse === true,
          updatedAt: Date.now()
        })
        break
      }
      case 'result': {
        ctx.onTextDone()
        const usage = msg.usage
        this.emit({
          kind: 'result',
          sessionId: msg.session_id,
          isError: msg.subtype !== 'success',
          errorText:
            msg.subtype !== 'success' ? (msg as { errors?: string[] }).errors?.join('\n') : undefined,
          usage: {
            totalCostUsd: msg.total_cost_usd,
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
            cacheCreationTokens: usage?.cache_creation_input_tokens ?? 0,
            durationMs: msg.duration_ms,
            numTurns: msg.num_turns
          }
        })
        break
      }
      default:
        break
    }
  }
}
