import type { BrowserWindow } from 'electron'
import { ClaudeRunner, drawAttention, type RunnerSink } from './claude'
import { delegateRules } from '../shared/delegate'
import { extractJsonObjects } from '../shared/json'
import {
  EMPLOYEE_PRESETS,
  DISPATCH_TASK_ID,
  TEAM_REPORT_RULES,
  type AppConfig,
  type ClaudeEvent,
  type DispatchArgs,
  type DispatchAssignment,
  type DispatchPlan,
  type PermissionAnswer,
  type PermissionRequest,
  type TeamStartArgs
} from '../shared/types'

/** 팀장의 마지막 메시지에서 JSON 배분 계획을 꺼낸다 (```json 블록 우선, 없으면 첫 { ~ 마지막 }) */
export function parseDispatchPlan(text: string): DispatchPlan {
  // 답변 안의 JSON 객체 가운데 배분 계획처럼 생긴 마지막 것을 쓴다.
  // (코드블록 기준으로 자르면 지시문 안에 든 코드블록에서 끊겨 읽지 못한다)
  const plans = extractJsonObjects(text).filter((o) => 'assignments' in o || 'directAnswer' in o || 'summary' in o)
  const raw = plans[plans.length - 1]
  // JSON 없이 글로만 답했으면 그 글을 팀장의 답으로 돌려준다 (오류로 멈추지 않는다)
  if (!raw) {
    if (!text.trim()) throw new Error('팀장이 답을 내지 않았습니다.')
    return { summary: '', assignments: [], directAnswer: text.trim() }
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
  /** 실행 중인 작업 → 실행이 끝날 때 풀리는 약속 */
  private ending = new Map<string, Promise<void>>()
  /** 중단을 요청해 끝나는 중인 작업. 중단 직후 "이어서"를 누르면 끝나기를 기다렸다 시작한다 */
  private stopping = new Map<string, Promise<void>>()
  /** 팀장이 배분 중인 요청 수 */
  private dispatching = 0

  constructor(
    private win: BrowserWindow,
    private getConfig: () => { config: AppConfig; apiKey: string | null }
  ) {}

  get runningTaskIds(): string[] {
    return [...this.runners.keys()]
  }

  get isDispatching(): boolean {
    return this.dispatching > 0
  }

  /** 직원 작업들이 답을 기다리는 권한 요청 (taskId 포함) */
  get pendingRequests(): PermissionRequest[] {
    return [...this.runners].flatMap(([taskId, r]) => r.pendingRequests.map((req) => ({ ...req, taskId })))
  }

  /** 직원 지시문 + 공통 보고 규칙 */
  static systemPrompt(args: TeamStartArgs): string {
    const e = args.employee
    return (
      `# 역할\n당신의 이름은 "${e.name}", 직함은 "${e.role}" 입니다. 전문 분야: ${e.specialty}\n\n` +
      `# 지시문\n${e.instructions.trim()}` +
      (args.memory ? `\n\n${args.memory.trim()}` : '') +
      // 조율 역할(PM 등)은 같은 팀 직원에게 일을 맡길 수 있다
      (args.roster !== undefined ? delegateRules(args.roster) : '') +
      TEAM_REPORT_RULES
    )
  }

  /** 첫 지시 또는 수정 요청 프롬프트 */
  static prompt(args: TeamStartArgs): string {
    // 조율하는 역할(PM 등)에게는 지금 팀이 하고 있는 일을 함께 알려 준다
    const status = args.teamStatus?.trim() ? `\n\n${args.teamStatus.trim()}` : ''
    if (args.followUp) return args.followUp + status
    const t = args.task
    return `# 작업: ${t.title}\n\n${t.instructions.trim()}\n\n작업 폴더: ${t.cwd}${status}`
  }

  async start(args: TeamStartArgs): Promise<void> {
    const taskId = args.task.id
    if (this.runners.has(taskId)) {
      const ending = this.stopping.get(taskId)
      if (!ending) throw new Error('이미 실행 중인 작업입니다.')
      await ending
    }

    const sink: RunnerSink = {
      emit: (event: ClaudeEvent) => {
        if (!this.win.isDestroyed()) {
          this.win.webContents.send('team:event', { taskId, event, afterStop: this.stopping.has(taskId) || undefined })
        }
      },
      requestPermission: (req) => {
        if (this.win.isDestroyed()) return
        this.win.webContents.send('claude:permission', { ...req, taskId })
        drawAttention(this.win)
      },
      permissionClosed: (requestId) => {
        if (!this.win.isDestroyed()) this.win.webContents.send('claude:permission-closed', requestId)
      }
    }
    const runner = new ClaudeRunner(this.win, this.getConfig, sink)
    this.runners.set(taskId, runner)
    let ended: () => void = () => {}
    this.ending.set(taskId, new Promise<void>((r) => (ended = r)))
    try {
      await runner.run({
        prompt: TeamRunner.prompt(args),
        cwd: args.task.cwd,
        // 수정 요청이면 같은 세션을 이어가고, 첫 지시면 새 세션
        sessionId: args.followUp ? args.task.sessionId : undefined,
        permissionMode: args.employee.permissionMode,
        systemPromptAppend: TeamRunner.systemPrompt(args),
        model: args.employee.model,
        effort: args.employee.effort
      })
    } finally {
      this.runners.delete(taskId)
      this.stopping.delete(taskId)
      this.ending.delete(taskId)
      ended()
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

${args.teamStatus?.trim() ? `${args.teamStatus.trim()}\n\n` : ''}${args.memory ? `${args.memory.trim()}\n\n` : ''}# 배분 규칙
- "팀 작업 현황"이 위에 있으면 그것은 이 요청을 받은 시점의 실제 상태입니다. 진행 상황, 누가 무엇을 하는지, 결과를 묻는 요청이면 새 작업을 만들지 말고 그 현황을 근거로 directAnswer 에 직접 답하세요. 현황에 없는 내용은 지어내지 마세요.
- 이미 진행 중이거나 검토를 기다리는 작업과 겹치는 일은 새로 만들지 말고, 그 작업이 있다는 것을 directAnswer 나 summary 로 알려 주세요.
- 같은 역할의 직원이 여럿이면 지금 작업 중이 아닌 직원에게 먼저 맡기세요.
- 요청이 단순 질문·대화·의견이라 직원에게 맡길 일이 아니면 assignments 를 빈 배열로 두고 directAnswer 에 직접 답하세요.
- 사용자가 실행을 요청했으면(만들어 줘, 진행, 고쳐 줘) 조사·계획 문서만 맡기고 끝내지 마세요. 실제로 구현하고 검증하는 작업을 개발·QA 직원에게 맡깁니다. 계획이 먼저 필요하면 계획을 첫 단계로 두되, 계획 단계가 두 번을 넘지 않게 하세요.
- 직원이 물어볼 만한 것 가운데 당신이 정할 수 있는 것(범위, 순서, 이름, 무난한 기본값)은 지시에 미리 정해서 적어 주세요. 직원이 사용자에게 같은 질문을 반복하게 두지 마세요.
${
  args.autoContinue
    ? `- 이 요청은 "자동 진행"이 켜져 있습니다. 지금 배분한 작업이 모두 끝나면 보고와 함께 당신이 다시 불려 다음 단계를 배분합니다 (최대 ${args.followUp?.maxRounds ?? 4}차). 그러니 서로의 결과에 의존하는 일을 한꺼번에 내지 말고 지금 할 수 있는 단계만 배분하세요 (예: 1차 구현 → 2차 검증). summary 에는 이번 단계와 그다음에 할 일을 한두 문장으로 적습니다.\n`
    : ''
}- 역할이 다른 일은 작업을 나눌 수 있습니다 (예: 구현 → 프론트엔드 개발자, 검증 → QA 엔지니어). 단, 작업들은 동시에 실행되므로 서로의 결과에 의존하는 일은 ${args.autoContinue ? '다음 차례로 미루세요' : '한 작업으로 합치세요'}.
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

  /** 팀장에게 보내는 요청문. 이어서 배분하는 호출이면 방금 끝난 작업의 보고를 함께 준다 */
  static dispatchRequest(args: DispatchArgs): string {
    const f = args.followUp
    if (!f) return `# 사용자 요청\n\n${args.request.trim()}\n\n작업 폴더: ${args.cwd}`
    return (
      `# 이어서 진행 (${f.round}차 / 최대 ${f.maxRounds}차)\n\n` +
      `## 사용자의 원래 요청\n${args.request.trim()}\n\n작업 폴더: ${args.cwd}\n\n` +
      `## 방금 끝난 작업의 보고\n${f.reports.trim()}\n\n` +
      `## 할 일\n` +
      `위 보고를 검토하고, 원래 요청을 끝내려면 무엇이 남았는지 판단하세요.\n` +
      `- 다음 단계가 남았으면 그 단계의 작업을 배분하세요 (이전 단계의 결과와 파일 경로를 지시에 적어 줍니다). 실패했거나 미흡한 작업은 무엇을 고쳐야 하는지 적어 같은 직원에게 다시 맡길 수 있습니다.\n` +
      `- 직원의 확인 요청 가운데 당신이 정할 수 있는 것은 정해서 다음 지시에 반영하세요.\n` +
      `- 원래 요청이 끝났으면 assignments 를 비우고 directAnswer 에 무엇이 만들어졌고 어디에 있는지, 어떻게 확인하는지 요약하세요.\n` +
      `- 사용자의 결정 없이는 더 진행할 수 없으면 assignments 를 비우고 directAnswer 에 그 질문만(가장 중요한 것 3개까지, 선택지와 추천안 포함) 적으세요.` +
      (f.round >= f.maxRounds ? `\n- 이번이 자동으로 이어 가는 마지막 차례입니다. 남은 일이 있으면 배분하되 summary 에 그 뒤에 남는 일을 적어 주세요.` : '')
    )
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
        // 팀장 세션이 쓴 사용량도 사이드바(플랜 한도·팀 사용량)에 잡히도록 전달한다
        if ((event.kind === 'rate_limit' || event.kind === 'result') && !this.win.isDestroyed()) {
          this.win.webContents.send('team:event', { taskId: DISPATCH_TASK_ID, event })
        }
      },
      // 읽기 도구만 허용하므로 권한 요청이 올 일은 거의 없다. 오면 거부
      requestPermission: (req) => runner?.answerPermission({ requestId: req.requestId, allow: false })
    }
    runner = new ClaudeRunner(this.win, this.getConfig, sink)
    this.dispatching++
    try {
      await runner.run({
        prompt: TeamRunner.dispatchRequest(args),
        cwd: args.cwd,
        permissionMode: 'default',
        systemPromptAppend: TeamRunner.dispatcherPrompt(args),
        model: args.model,
        allowedTools: ['Read', 'Glob', 'Grep'],
        disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'Task', 'WebFetch', 'WebSearch'],
        maxTurns: 10
      })
    } finally {
      this.dispatching--
    }
    if (!lastText && errorText) throw new Error(errorText)
    return parseDispatchPlan(lastText)
  }

  async stop(taskId: string): Promise<void> {
    const runner = this.runners.get(taskId)
    if (!runner) return
    const ending = this.ending.get(taskId)
    if (ending) this.stopping.set(taskId, ending)
    await runner.interrupt()
  }

  /** 직원 작업 세션 안에서 돌고 있는 작업 하나(백그라운드 셸·서브에이전트)를 멈춘다 */
  async stopBgTask(taskId: string, bgTaskId: string): Promise<void> {
    await this.runners.get(taskId)?.stopBgTask(bgTaskId)
  }

  async sendToBackground(taskId: string, toolUseId?: string): Promise<boolean> {
    return (await this.runners.get(taskId)?.sendToBackground(toolUseId)) ?? false
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
