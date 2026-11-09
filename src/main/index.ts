import { app, BrowserWindow, Menu, ipcMain, dialog, shell, type MenuItemConstructorOptions } from 'electron'
import { execFile, spawn } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { homedir, hostname } from 'os'
import { basename, dirname, extname, join } from 'path'
import { createRequire } from 'module'
import { ClaudeRunner } from './claude'
import { ConfigStore } from './config'
import { AppUpdater } from './updater'
import { TeamRunner } from './team'
import { TerminalManager } from './terminal'
import { createSkill, listSkills, skillsDir } from './skills'
import type {
  ActiveWork,
  AppConfig,
  Attachment,
  AuthStatus,
  CreateSkillArgs,
  DispatchArgs,
  FsEntry,
  FsRead,
  InstallResult,
  McpServerEntry,
  PermissionAnswer,
  PermissionRequest,
  SendPromptArgs,
  SkillScope,
  TeamStartArgs
} from '../shared/types'

let runner: ClaudeRunner | null = null
let team: TeamRunner | null = null
let updater: AppUpdater | null = null
let terminals: TerminalManager | null = null
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

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.csv': 'text/csv'
}
function mimeOf(p: string): string {
  return MIME[extname(p).toLowerCase()] ?? ''
}
/** 첨부 파일 메타 (이름·경로·크기·종류) */
function attachmentInfo(p: string, mime?: string): Attachment {
  let size: number | undefined
  try {
    size = statSync(p).size
  } catch {
    /* 없으면 비움 */
  }
  return { name: basename(p), path: p, size, mime: mime ?? mimeOf(p) ?? undefined }
}

/**
 * 번들된 CLI 의 `claude auth status` 로 로그인 여부·이메일·플랜을 읽는다.
 * 요청을 보내지 않아도 "claude.ai 로그인이 되어 있는지" 를 보여 주기 위한 것.
 * 상속된 API 키 환경 변수는 빼고 실행해 앱의 OAuth 모드와 같은 조건으로 확인한다.
 */
function authStatus(): Promise<AuthStatus> {
  const exe = bundledClaudeExe() ?? 'claude'
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v
  delete env.ANTHROPIC_API_KEY
  delete env.ANTHROPIC_AUTH_TOKEN
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
  return new Promise((resolve) => {
    execFile(
      exe,
      ['auth', 'status'],
      { timeout: 20_000, windowsHide: true, env, shell: exe === 'claude', maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        // 로그인이 안 돼 있어도 JSON 은 나오고 종료 코드만 0 이 아닐 수 있다 → 먼저 JSON 을 찾는다
        const text = String(stdout || '')
        const start = text.indexOf('{')
        if (start >= 0) {
          try {
            const j = JSON.parse(text.slice(start)) as Record<string, unknown>
            resolve({
              loggedIn: j.loggedIn === true,
              authMethod: str(j.authMethod),
              email: str(j.email),
              subscriptionType: str(j.subscriptionType),
              loginExpiresAt: str(j.loginExpiresAt),
              orgName: str(j.orgName),
              checkedAt: Date.now()
            })
            return
          } catch {
            /* 아래 오류 처리로 */
          }
        }
        resolve({
          loggedIn: false,
          error: (String(stderr || '').trim() || (err ? err.message : '') || '응답을 해석하지 못했습니다.').slice(0, 300),
          checkedAt: Date.now()
        })
      }
    )
  })
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

/** 폴더 패널: 한 단계 아래 항목들 (폴더 먼저, 이름순). 읽을 수 없으면 빈 배열 */
function listDir(dir: string): FsEntry[] {
  try {
    const out: FsEntry[] = []
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name)
      let isDir = d.isDirectory()
      let size: number | undefined
      let mtime: number | undefined
      if (d.isSymbolicLink()) {
        try {
          isDir = statSync(p).isDirectory()
        } catch {
          /* 깨진 링크는 파일처럼 보여준다 */
        }
      }
      if (!isDir) {
        try {
          const st = statSync(p)
          size = st.size
          mtime = st.mtimeMs
        } catch {
          /* 접근 불가 */
        }
      }
      out.push({ name: d.name, path: p, isDir, size, mtime })
      if (out.length >= 3000) break
    }
    out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'ko', { sensitivity: 'base', numeric: true }) : a.isDir ? -1 : 1))
    return out
  } catch {
    return []
  }
}

/** 폴더 패널 미리보기: 텍스트는 256KB 까지, 이미지는 8MB 까지 data URL 로 */
function readForPreview(p: string): FsRead {
  try {
    const st = statSync(p)
    if (st.isDirectory()) return { kind: 'error', message: '폴더입니다.' }
    const mime = mimeOf(p)
    if (mime.startsWith('image/')) {
      if (st.size > 8 * 1024 * 1024) return { kind: 'binary', size: st.size }
      return { kind: 'image', dataUrl: `data:${mime};base64,${readFileSync(p).toString('base64')}`, size: st.size }
    }
    const LIMIT = 256 * 1024
    const buf = readFileSync(p)
    const head = buf.subarray(0, Math.min(buf.length, 8192))
    if (head.includes(0)) return { kind: 'binary', size: st.size }
    const truncated = buf.length > LIMIT
    return { kind: 'text', text: (truncated ? buf.subarray(0, LIMIT) : buf).toString('utf8'), truncated, size: st.size }
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : String(e) }
  }
}

/** 지금 끊기면 안 되는 일 (업데이트 설치·창 닫기 전에 확인) */
function activeWork(): ActiveWork {
  return {
    chat: runner?.isRunning ?? false,
    teamTasks: team?.runningTaskIds.length ?? 0,
    dispatching: team?.isDispatching ?? false,
    terminals: terminals?.ids.length ?? 0
  }
}

/**
 * 기본 메뉴에는 새로고침(Ctrl+R)과 창 닫기(Ctrl+W)가 들어 있어 터미널에서 같은 키를 누르면 화면이 통째로
 * 다시 로드되거나 닫힌다. 그러면 대화·팝업·터미널이 사라지므로 설치된 앱에서는 두 항목을 뺀 메뉴를 쓴다.
 */
function installMenu(): void {
  const dev = !!process.env['ELECTRON_RENDERER_URL']
  const view: MenuItemConstructorOptions[] = [
    ...(dev ? ([{ role: 'reload' }, { role: 'forceReload' }] as MenuItemConstructorOptions[]) : []),
    { role: 'toggleDevTools' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ]
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '편집',
        submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
      },
      { label: '보기', submenu: view },
      { label: '창', submenu: [{ role: 'minimize' }] }
    ])
  )
}

function createWindow(): void {
  installMenu()
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
      sandbox: false,
      // 오른쪽 패널의 내장 브라우저(<webview>)
      webviewTag: true
    }
  })
  terminals = new TerminalManager(win)

  // Claude 가 일하는 중에 창을 닫으면 작업이 끊기므로 한 번 확인받는다 (업데이트 설치는 작업이 없을 때만 진행되므로 여기 걸리지 않는다)
  let closeConfirmed = false
  win.on('close', (e) => {
    if (closeConfirmed) return
    const w = activeWork()
    const lines: string[] = []
    if (w.chat) lines.push('· 채팅에서 Claude 가 응답 중입니다')
    if (w.dispatching) lines.push('· 팀장이 요청을 배분하는 중입니다')
    if (w.teamTasks > 0) lines.push(`· 직원 작업 ${w.teamTasks}개가 진행 중입니다`)
    if (lines.length === 0) return
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      title: 'Claude CLI Studio',
      message: '진행 중인 작업이 있습니다. 종료할까요?',
      detail: `${lines.join('\n')}\n\n종료하면 작업이 중단됩니다. 중단된 직원 작업은 다음 실행 때 "중단됨"으로 남습니다.`,
      buttons: ['계속 작업', '종료'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    })
    if (choice === 1) closeConfirmed = true
    else e.preventDefault()
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

// 내장 브라우저(<webview>) 보안: 게스트 페이지에는 preload·Node 를 주지 않고, 새 창은 같은 webview 안에서 연다
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (_ev, webPreferences) => {
    delete (webPreferences as { preload?: string }).preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
  })
  contents.on('did-attach-webview', (_ev, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      if (/^https?:/i.test(url)) void guest.loadURL(url)
      return { action: 'deny' }
    })
  })
})

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
  // 답을 기다리는 권한 요청 전체. 화면이 다시 로드됐을 때 팝업을 복구하는 데 쓴다
  ipcMain.handle('claude:pending-permissions', (): PermissionRequest[] => [
    ...(runner?.pendingRequests ?? []),
    ...(team?.pendingRequests ?? [])
  ])

  // ----- 팀 (직원 에이전트) -----
  ipcMain.handle('team:start', async (_e, args: TeamStartArgs) => {
    if (!team) throw new Error('창이 준비되지 않았습니다.')
    await team.start(args)
  })
  ipcMain.handle('team:stop', async (_e, taskId: string) => {
    await team?.stop(taskId)
  })
  ipcMain.handle('team:running', () => team?.runningTaskIds ?? [])
  // 채팅 요청 → 팀장이 직원 작업으로 배분
  ipcMain.handle('team:dispatch', async (_e, args: DispatchArgs) => {
    if (!team) throw new Error('창이 준비되지 않았습니다.')
    return team.dispatch(args)
  })

  // ----- 폴더 / 앱 -----
  ipcMain.handle('dialog:pick-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  // ----- 첨부 파일 -----
  ipcMain.handle('dialog:pick-files', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '모든 파일', extensions: ['*'] },
        { name: '이미지', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
        { name: '문서', extensions: ['pdf', 'md', 'txt', 'csv', 'json'] }
      ]
    })
    if (result.canceled) return []
    return result.filePaths.map((p) => attachmentInfo(p))
  })
  // 클립보드에서 붙여넣은 이미지는 userData/attachments 에 파일로 저장하고 그 경로를 쓴다
  ipcMain.handle('attach:save-clipboard', (_e, args: { base64: string; mime: string }) => {
    const ext = args.mime === 'image/jpeg' ? 'jpg' : args.mime === 'image/gif' ? 'gif' : args.mime === 'image/webp' ? 'webp' : 'png'
    const dir = join(app.getPath('userData'), 'attachments')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = join(dir, `clipboard-${stamp}.${ext}`)
    writeFileSync(file, Buffer.from(args.base64, 'base64'))
    return attachmentInfo(file, args.mime)
  })
  // 이미지 미리보기용 data URL (8MB 이하만)
  ipcMain.handle('attach:preview', (_e, p: string) => {
    try {
      const st = statSync(p)
      if (st.size > 8 * 1024 * 1024) return null
      const mime = mimeOf(p)
      if (!mime.startsWith('image/')) return null
      return `data:${mime};base64,${readFileSync(p).toString('base64')}`
    } catch {
      return null
    }
  })
  // ----- 터미널 패널 -----
  ipcMain.handle('term:create', (_e, args: { cwd: string; cols?: number; rows?: number }) => {
    if (!terminals) throw new Error('창이 준비되지 않았습니다.')
    return terminals.create(args.cwd, args.cols, args.rows)
  })
  ipcMain.on('term:write', (_e, id: string, data: string) => terminals?.write(id, data))
  ipcMain.on('term:resize', (_e, id: string, cols: number, rows: number) => terminals?.resize(id, cols, rows))
  ipcMain.handle('term:kill', (_e, id: string) => terminals?.kill(id))

  // ----- 폴더 패널 -----
  ipcMain.handle('fs:list', (_e, dir: string): FsEntry[] => listDir(dir))
  ipcMain.handle('fs:read', (_e, p: string): FsRead => readForPreview(p))
  ipcMain.handle('fs:reveal', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('fs:home', () => homedir())
  ipcMain.handle('fs:is-dir', (_e, p: string) => {
    try {
      return statSync(p).isDirectory()
    } catch {
      return false
    }
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
  ipcMain.handle('auth:status', () => authStatus())
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
  // 설치하면 앱이 재시작되므로, 끊기면 안 되는 일이 있으면 막고 터미널이 열려 있으면 확인을 요구한다
  ipcMain.handle('update:install', (_e, opts?: { confirmTerminals?: boolean }): InstallResult => {
    const work = activeWork()
    if (work.chat || work.dispatching || work.teamTasks > 0) return { ok: false, reason: 'busy', work }
    if (work.terminals > 0 && !opts?.confirmTerminals) return { ok: false, reason: 'terminals', work }
    if (updater?.getStatus().state !== 'downloaded') return { ok: false, reason: 'not-ready', work }
    updater.install()
    return { ok: true }
  })
  ipcMain.handle('app:active-work', () => activeWork())
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
