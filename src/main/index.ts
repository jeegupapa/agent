import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron'
import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { homedir, hostname } from 'os'
import { dirname, join } from 'path'
import { createRequire } from 'module'
import { ClaudeRunner } from './claude'
import { ConfigStore } from './config'
import { AppUpdater } from './updater'
import { TeamRunner } from './team'
import { createSkill, listSkills, skillsDir } from './skills'
import type {
  AppConfig,
  CreateSkillArgs,
  McpServerEntry,
  PermissionAnswer,
  SendPromptArgs,
  SkillScope,
  TeamStartArgs
} from '../shared/types'

let runner: ClaudeRunner | null = null
let team: TeamRunner | null = null
let updater: AppUpdater | null = null
const store = new ConfigStore()

/** SDK 와 함께 설치된 claude.exe 경로 (터미널 로그인용) */
function bundledClaudeExe(): string | null {
  try {
    const req = createRequire(__filename)
    const pkg = req.resolve('@anthropic-ai/claude-agent-sdk-win32-x64/package.json')
    const exe = join(dirname(pkg), 'claude.exe')
    return existsSync(exe) ? exe : null
  } catch {
    return null
  }
}

/** ~/.claude.json 의 전역 MCP 서버와 해당 프로젝트 MCP 서버를 앱 설정 형태로 읽는다 */
function importClaudeMcp(cwd: string): McpServerEntry[] {
  const file = join(homedir(), '.claude.json')
  if (!existsSync(file)) return []
  let json: {
    mcpServers?: Record<string, Record<string, unknown>>
    projects?: Record<string, { mcpServers?: Record<string, Record<string, unknown>> }>
  }
  try {
    json = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const merged: Record<string, Record<string, unknown>> = {
    ...(json.mcpServers ?? {}),
    ...(json.projects?.[cwd]?.mcpServers ?? {})
  }
  return Object.entries(merged).map(([name, c]) => {
    const type = (c.type as string | undefined) ?? (c.url ? 'http' : 'stdio')
    return {
      name,
      enabled: true,
      type: type === 'sse' ? 'sse' : type === 'http' ? 'http' : 'stdio',
      command: typeof c.command === 'string' ? c.command : undefined,
      args: Array.isArray(c.args) ? (c.args as string[]) : undefined,
      env: (c.env as Record<string, string> | undefined) ?? undefined,
      url: typeof c.url === 'string' ? c.url : undefined,
      headers: (c.headers as Record<string, string> | undefined) ?? undefined
    }
  })
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Claude CLI Studio',
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  runner = new ClaudeRunner(win, () => ({ config: store.load(), apiKey: store.getApiKey() }))
  team = new TeamRunner(win, () => ({ config: store.load(), apiKey: store.getApiKey() }))
  updater = new AppUpdater(
    win,
    () => store.load().update,
    () => store.getUpdateToken()
  )
  win.webContents.once('did-finish-load', () => updater?.checkOnStartup())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // ----- Claude 실행 -----
  ipcMain.handle('claude:send', async (_e, args: SendPromptArgs) => {
    if (!runner) throw new Error('창이 준비되지 않았습니다.')
    await runner.run(args)
  })
  ipcMain.handle('claude:interrupt', async () => {
    await runner?.interrupt()
  })
  ipcMain.on('claude:permission-answer', (_e, answer: PermissionAnswer) => {
    // 팀 작업의 요청이면 그쪽 러너가 받고, 아니면 메인 채팅 러너
    if (!team?.answerPermission(answer)) runner?.answerPermission(answer)
  })

  // ----- 팀 (직원 에이전트) -----
  ipcMain.handle('team:start', async (_e, args: TeamStartArgs) => {
    if (!team) throw new Error('창이 준비되지 않았습니다.')
    await team.start(args)
  })
  ipcMain.handle('team:stop', async (_e, taskId: string) => {
    await team?.stop(taskId)
  })
  ipcMain.handle('team:running', () => team?.runningTaskIds ?? [])

  // ----- 폴더 / 앱 -----
  ipcMain.handle('dialog:pick-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('app:default-cwd', () => process.cwd())
  ipcMain.handle('app:hostname', () => hostname())
  ipcMain.handle('app:open-path', (_e, p: string) => shell.openPath(p))

  // ----- 설정 -----
  ipcMain.handle('config:get', () => store.view())
  ipcMain.handle('config:set', (_e, config: AppConfig) => {
    store.save(config)
    updater?.applyConfig(store.load().update)
    return store.view()
  })
  ipcMain.handle('config:set-api-key', (_e, key: string | null) => {
    store.setApiKey(key && key.trim() ? key.trim() : null)
    return store.view()
  })

  // ----- 인증 -----
  ipcMain.handle('auth:login-terminal', () => {
    // 별도 콘솔 창을 띄워 `claude login` 을 실행한다 (OAuth 는 브라우저로 이어짐)
    const exe = bundledClaudeExe() ?? 'claude'
    const child = spawn('cmd.exe', ['/c', 'start', '"Claude 로그인"', 'cmd', '/k', `"${exe}" login`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      shell: true
    })
    child.unref()
    return exe
  })

  // ----- MCP -----
  ipcMain.handle('mcp:import-claude', (_e, cwd: string) => importClaudeMcp(cwd))

  // ----- 스킬 -----
  ipcMain.handle('skills:list', (_e, cwd: string) => listSkills(cwd))
  ipcMain.handle('skills:create', (_e, args: CreateSkillArgs) => createSkill(args))
  ipcMain.handle('skills:open-folder', async (_e, scope: SkillScope, cwd: string) => {
    const dir = skillsDir(scope, cwd)
    const { mkdirSync } = await import('fs')
    mkdirSync(dir, { recursive: true })
    return shell.openPath(dir)
  })

  // ----- 자동 업데이트 -----
  ipcMain.handle('update:get-status', () => updater?.getStatus() ?? null)
  ipcMain.handle('update:check', () => updater?.check())
  ipcMain.handle('update:download', () => updater?.download())
  ipcMain.handle('update:install', () => updater?.install())
  ipcMain.handle('update:info', () => ({
    version: app.getVersion(),
    packaged: app.isPackaged,
    feed: updater?.feedDescription() ?? '',
    logPath: updater?.logPath() ?? '',
    hasToken: store.getUpdateToken() !== null
  }))
  ipcMain.handle('update:set-token', (_e, token: string | null) => {
    store.setUpdateToken(token && token.trim() ? token.trim() : null)
    updater?.applyConfig(store.load().update)
    return store.view()
  })

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  void team?.stopAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
