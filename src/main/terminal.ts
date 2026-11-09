import { BrowserWindow } from 'electron'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { delimiter, join } from 'path'
import { randomUUID } from 'crypto'
import * as pty from '@lydell/node-pty'
import type { TermCreateResult, TermEvent } from '../shared/types'

/** PATH 에서 실행 파일을 찾는다 (Windows 는 .exe 가 붙은 이름으로) */
function findInPath(file: string): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    const p = join(dir, file)
    if (existsSync(p)) return p
  }
  return null
}

/** 기본 셸: Windows 는 pwsh → powershell, 그 외는 $SHELL */
export function defaultShell(): { file: string; args: string[]; label: string } {
  if (process.platform === 'win32') {
    const pwsh = findInPath('pwsh.exe') ?? (existsSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe') ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null)
    if (pwsh) return { file: pwsh, args: ['-NoLogo'], label: 'pwsh' }
    return { file: 'powershell.exe', args: ['-NoLogo'], label: 'powershell' }
  }
  const sh = process.env['SHELL'] || '/bin/bash'
  return { file: sh, args: ['-l'], label: sh.split('/').pop() ?? 'sh' }
}

function termEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
  delete env['ELECTRON_RUN_AS_NODE']
  env['TERM'] = 'xterm-256color'
  env['COLORTERM'] = 'truecolor'
  env['TERM_PROGRAM'] = 'claude-cli-studio'
  return env
}

/**
 * 렌더러의 xterm 과 짝을 이루는 PTY 들. 출력은 `term:event` 로 보내고,
 * 입력·크기 변경은 IPC 로 받는다. 창이 닫히면 전부 종료한다.
 */
export class TerminalManager {
  private terms = new Map<string, pty.IPty>()

  constructor(private readonly win: BrowserWindow) {
    win.on('closed', () => this.killAll())
    // 렌더러가 새로고침되면 화면 쪽 터미널이 사라지므로 남은 PTY 도 정리한다
    win.webContents.on('did-finish-load', () => this.killAll())
  }

  private send(ev: TermEvent): void {
    if (!this.win.isDestroyed()) this.win.webContents.send('term:event', ev)
  }

  create(cwd: string, cols = 80, rows = 24): TermCreateResult {
    const shell = defaultShell()
    const id = randomUUID()
    const dir = cwd && existsSync(cwd) ? cwd : homedir()
    const proc = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: Math.max(2, cols),
      rows: Math.max(1, rows),
      cwd: dir,
      env: termEnv()
    })
    this.terms.set(id, proc)
    proc.onData((data) => this.send({ kind: 'data', id, data }))
    proc.onExit(({ exitCode }) => {
      this.terms.delete(id)
      this.send({ kind: 'exit', id, exitCode })
    })
    return { id, shell: shell.label, cwd: dir }
  }

  write(id: string, data: string): void {
    this.terms.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.terms.get(id)
    if (!t) return
    try {
      t.resize(Math.max(2, Math.floor(cols)), Math.max(1, Math.floor(rows)))
    } catch {
      /* 종료 직후의 resize 는 무시 */
    }
  }

  kill(id: string): void {
    const t = this.terms.get(id)
    if (!t) return
    this.terms.delete(id)
    try {
      t.kill()
    } catch {
      /* 이미 종료됨 */
    }
  }

  killAll(): void {
    for (const id of [...this.terms.keys()]) this.kill(id)
  }

  get ids(): string[] {
    return [...this.terms.keys()]
  }
}
