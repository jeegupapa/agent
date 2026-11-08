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
import type {
  AppConfig,
  ClaudeEvent,
  PermissionAnswer,
  PlanWindow,
  SendPromptArgs,
  ToolCallRecord
} from '../shared/types'

/** 초 단위 epoch 를 밀리초로. 이미 밀리초면 그대로. */
function toMillis(t?: number): number | undefined {
  if (t === undefined || t === null) return undefined
  return t < 1e12 ? t * 1000 : t
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

/**
 * Agent SDK의 query()를 감싸서 렌더러가 그리기 쉬운 ClaudeEvent 스트림으로 바꿔준다.
 * - 텍스트는 stream_event 로 글자 단위로 흘려보내고
 * - tool_use / tool_result 는 ToolCallRecord 로 묶어서 보낸다
 * - 권한 요청(canUseTool)은 렌더러에 물어보고 답을 기다린다
 */
export class ClaudeRunner {
  private current: Query | null = null
  private pendingPermissions = new Map<string, (answer: PermissionAnswer) => void>()

  constructor(
    private win: BrowserWindow,
    private getConfig: () => { config: AppConfig; apiKey: string | null }
  ) {}

  get isRunning(): boolean {
    return this.current !== null
  }

  private emit(event: ClaudeEvent): void {
    if (!this.win.isDestroyed()) this.win.webContents.send('claude:event', event)
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
      model: config.model?.trim() || undefined,
      canUseTool: async (toolName, input, { signal, suggestions }): Promise<PermissionResult> => {
        const requestId = randomUUID()
        const answer = await new Promise<PermissionAnswer>((resolve) => {
          this.pendingPermissions.set(requestId, resolve)
          signal.addEventListener('abort', () => {
            this.pendingPermissions.delete(requestId)
            resolve({ requestId, allow: false })
          })
          this.win.webContents.send('claude:permission', { requestId, toolName, input })
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

    // stream_event 에서 현재 조립 중인 블록을 추적한다
    let currentText = ''
    const openToolInputs = new Map<number, { id: string; name: string; json: string }>()

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

  private handleMessage(
    msg: SDKMessage,
    ctx: {
      onText: (delta: string) => void
      onTextDone: () => void
      openToolInputs: Map<number, { id: string; name: string; json: string }>
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
        }
        break
      }
      case 'stream_event': {
        if (msg.parent_tool_use_id) break // 서브에이전트 출력은 생략
        const ev = msg.event
        if (ev.type === 'content_block_start') {
          const block = ev.content_block
          if (block.type === 'tool_use') {
            ctx.openToolInputs.set(ev.index, { id: block.id, name: block.name, json: '' })
          }
        } else if (ev.type === 'content_block_delta') {
          const d = ev.delta
          if (d.type === 'text_delta') ctx.onText(d.text)
          else if (d.type === 'thinking_delta') this.emit({ kind: 'thinking_delta', text: d.thinking })
          else if (d.type === 'input_json_delta') {
            const open = ctx.openToolInputs.get(ev.index)
            if (open) open.json += d.partial_json
          }
        } else if (ev.type === 'content_block_stop') {
          const open = ctx.openToolInputs.get(ev.index)
          if (open) {
            ctx.openToolInputs.delete(ev.index)
            let input: Record<string, unknown> = {}
            try {
              input = open.json ? JSON.parse(open.json) : {}
            } catch {
              input = { _raw: open.json }
            }
            const call: ToolCallRecord = {
              id: open.id,
              name: open.name,
              input,
              status: 'running',
              startedAt: Date.now()
            }
            ctx.onTextDone()
            this.emit({ kind: 'tool_start', call })
          } else {
            ctx.onTextDone()
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
              this.emit({
                kind: 'tool_result',
                id: block.tool_use_id,
                result: text,
                isError: block.is_error === true
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
