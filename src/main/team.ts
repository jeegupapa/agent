import type { BrowserWindow } from 'electron'
import { ClaudeRunner, type RunnerSink } from './claude'
import {
  EMPLOYEE_PRESETS,
  TEAM_REPORT_RULES,
  type AppConfig,
  type ClaudeEvent,
  type DispatchArgs,
  type DispatchAssignment,
  type DispatchPlan,
  type PermissionAnswer,
  type TeamStartArgs
} from '../shared/types'

/** 팀장의 마지막 메시지에서 JSON 배분 계획을 꺼낸다 (```json 블록 우선, 없으면 첫 { ~ 마지막 }) */
export function parseDispatchPlan(text: string): DispatchPlan {
  let candidate: string | undefined
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    if (m[1].trim().startsWith('{')) candidate = m[1]
  }
  if (!candidate) {
    const s = text.indexOf('{')
    const e = text.lastIndexOf('}')
    if (s >= 0 && e > s) candidate = text.slice(s, e + 1)
  }
  if (!candidate) throw new Error('팀장이 배분 결과(JSON)를 내지 않았습니다.\n' + text.slice(0, 500))
  let raw: unknown
  try {
    raw = JSON.parse(candidate)
  } catch {
    throw new Error('팀장의 배분 결과를 해석하지 못했습니다.\n' + candidate.slice(0, 500))
  }
  const o = (raw ?? {}) as Partial<DispatchPlan>
  const assignments: DispatchAssignment[] = Array.isArray(o.assignments)
    ? o.assignments
        .filter((a): a is DispatchAssignment => !!a && typeof a.title === 'string' && typeof a.instructions === 'string')
        .map((a) => ({
          employeeId: a.employeeId ? String(a.employeeId) : undefined,
          presetRole: a.presetRole ? String(a.presetRole) : undefined,
          title: a.title.trim(),
          instructions: a.instructions.trim()
        }))
    : []
  const directAnswer = typeof o.directAnswer === 'string' && o.directAnswer.trim() ? o.directAnswer.trim() : undefined
  return { summary: typeof o.summary === 'string' ? o.summary.trim() : '', assignments, directAnswer }
}

/**
 * 직원 에이전트 작업을 여러 개 동시에 돌린다. 작업마다 ClaudeRunner 하나를 만들고,
 * 이벤트는 `team:event` { taskId, event } 로, 권한 요청은 `claude:permission` 에 taskId 를 붙여 보낸다.
 */
export class TeamRunner {
  private runners = new Map<string, ClaudeRunner>()

  constructor(
    private win: BrowserWindow,
    private getConfig: () => { config: AppConfig; apiKey: string | null }
  ) {}

  get runningTaskIds(): string[] {
    return [...this.runners.keys()]
  }

  /** 직원 지시문 + 공통 보고 규칙 */
  static systemPrompt(args: TeamStartArgs): string {
    const e = args.employee
    return (
      `# 역할\n당신의 이름은 "${e.name}", 직함은 "${e.role}" 입니다. 전문 분야: ${e.specialty}\n\n` +
      `# 지시문\n${e.instructions.trim()}` +
      TEAM_REPORT_RULES
    )
  }

  /** 첫 지시 또는 수정 요청 프롬프트 */
  static prompt(args: TeamStartArgs): string {
    if (args.followUp) return args.followUp
    const t = args.task
    return `# 작업: ${t.title}\n\n${t.instructions.trim()}\n\n작업 폴더: ${t.cwd}`
  }

  async start(args: TeamStartArgs): Promise<void> {
    const taskId = args.task.id
    if (this.runners.has(taskId)) throw new Error('이미 실행 중인 작업입니다.')

    const sink: RunnerSink = {
      emit: (event: ClaudeEvent) => {
        if (!this.win.isDestroyed()) this.win.webContents.send('team:event', { taskId, event })
      },
      requestPermission: (req) => {
        if (!this.win.isDestroyed()) this.win.webContents.send('claude:permission', { ...req, taskId })
      }
    }
    const runner = new ClaudeRunner(this.win, this.getConfig, sink)
    this.runners.set(taskId, runner)
    try {
      await runner.run({
        prompt: TeamRunner.prompt(args),
        cwd: args.task.cwd,
        // 수정 요청이면 같은 세션을 이어가고, 첫 지시면 새 세션
        sessionId: args.followUp ? args.task.sessionId : undefined,
        permissionMode: args.employee.permissionMode,
        systemPromptAppend: TeamRunner.systemPrompt(args),
        model: args.employee.model
      })
    } finally {
      this.runners.delete(taskId)
    }
  }

  /** 팀장 역할 지시문: 직원 목록, 채용 가능한 템플릿, 배분 규칙, JSON 출력 형식 */
  static dispatcherPrompt(args: DispatchArgs): string {
    const emps = args.employees.length
      ? args.employees.map((e) => `- id: ${e.id} | 이름: ${e.name} | 직함: ${e.role} | 전문: ${e.specialty}`).join('\n')
      : '(아직 직원이 없습니다. 아래 템플릿으로 채용하세요.)'
    const presets = EMPLOYEE_PRESETS.map((p) => `- ${p.role}: ${p.specialty}`).join('\n')
    return `# 역할
당신은 개발팀의 팀장입니다. 사용자가 채팅으로 보낸 요청을 읽고 아래 직원들에게 작업을 배분합니다.
코드는 직접 고치지 않습니다. 작업 지시를 구체화하기 위해 필요하면 Read/Glob/Grep 으로 프로젝트를 잠깐 살펴볼 수 있습니다 (몇 번만, 깊이 파지 마세요).

# 현재 직원
${emps}

# 채용 가능한 템플릿
맞는 직원이 없으면 presetRole 에 아래 직함을 그대로 적으세요. 자동으로 채용됩니다.
${presets}

# 배분 규칙
- 요청이 단순 질문·대화·의견이라 직원에게 맡길 일이 아니면 assignments 를 빈 배열로 두고 directAnswer 에 직접 답하세요.
- 역할이 다른 일은 작업을 나눌 수 있습니다 (예: 구현 → 프론트엔드 개발자, 검증 → QA 엔지니어). 단, 작업들은 동시에 실행되므로 서로의 결과에 의존하는 일은 한 작업으로 합치세요.
- 보통 1~3개 작업이면 충분합니다. 불필요하게 쪼개지 마세요.
- 각 작업의 instructions 는 그 직원이 이것만 읽고 바로 시작할 수 있게 적으세요: 무엇을, 왜, 완료 기준, 건드리면 안 되는 것, 참고할 파일.
- title 은 20자 안팎의 한 줄.

# 출력 형식
마지막 메시지는 다른 설명 없이 아래 JSON 하나만 코드블록으로 출력하세요.
\`\`\`json
{
  "summary": "사용자에게 보여줄 배분 요약 한두 문장",
  "assignments": [
    { "employeeId": "기존 직원 id (템플릿 채용이면 생략)", "presetRole": "템플릿 직함 (기존 직원이면 생략)", "title": "작업 제목", "instructions": "작업 지시" }
  ],
  "directAnswer": "직원에게 맡길 일이 아닐 때만 채움"
}
\`\`\``
  }

  /** 채팅 요청을 팀장 에이전트가 읽고 직원 작업으로 배분한다. 읽기 도구만 쓰고 턴 수를 제한한다 */
  async dispatch(args: DispatchArgs): Promise<DispatchPlan> {
    let lastText = ''
    let errorText: string | undefined
    let runner: ClaudeRunner | null = null
    const sink: RunnerSink = {
      emit: (event: ClaudeEvent) => {
        if (event.kind === 'text_done') lastText = event.text
        else if (event.kind === 'error') errorText = event.message
        else if (event.kind === 'result' && event.isError) errorText = event.errorText ?? '팀장 실행이 실패했습니다.'
      },
      // 읽기 도구만 허용하므로 권한 요청이 올 일은 거의 없다. 오면 거부
      requestPermission: (req) => runner?.answerPermission({ requestId: req.requestId, allow: false })
    }
    runner = new ClaudeRunner(this.win, this.getConfig, sink)
    await runner.run({
      prompt: `# 사용자 요청\n\n${args.request.trim()}\n\n작업 폴더: ${args.cwd}`,
      cwd: args.cwd,
      permissionMode: 'default',
      systemPromptAppend: TeamRunner.dispatcherPrompt(args),
      model: args.model,
      allowedTools: ['Read', 'Glob', 'Grep'],
      disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task', 'WebFetch', 'WebSearch'],
      maxTurns: 10
    })
    if (!lastText && errorText) throw new Error(errorText)
    return parseDispatchPlan(lastText)
  }

  async stop(taskId: string): Promise<void> {
    await this.runners.get(taskId)?.interrupt()
  }

  /** requestId 가 속한 러너를 찾아 답을 전달한다. 처리했으면 true */
  answerPermission(answer: PermissionAnswer): boolean {
    for (const r of this.runners.values()) {
      if (r.hasPendingPermission(answer.requestId)) {
        r.answerPermission(answer)
        return true
      }
    }
    return false
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runners.values()].map((r) => r.interrupt()))
  }
}
