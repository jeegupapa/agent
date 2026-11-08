import type { BrowserWindow } from 'electron'
import { ClaudeRunner, type RunnerSink } from './claude'
import {
  TEAM_REPORT_RULES,
  type AppConfig,
  type ClaudeEvent,
  type PermissionAnswer,
  type TeamStartArgs
} from '../shared/types'

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
