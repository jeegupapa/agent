import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  ActiveWork,
  AppConfig,
  AppConfigView,
  Attachment,
  AuthStatus,
  ClaudeEvent,
  CreateSkillArgs,
  DispatchArgs,
  DispatchPlan,
  FsEntry,
  FsRead,
  InstallResult,
  McpServerEntry,
  PermissionAnswer,
  PermissionRequest,
  SendPromptArgs,
  SkillInfo,
  SkillScope,
  TeamEvent,
  TeamStartArgs,
  TermCreateResult,
  TermEvent,
  UpdateStatus
} from '../shared/types'

const api = {
  // Claude 실행
  send: (args: SendPromptArgs): Promise<void> => ipcRenderer.invoke('claude:send', args),
  interrupt: (): Promise<void> => ipcRenderer.invoke('claude:interrupt'),
  answerPermission: (answer: PermissionAnswer): void =>
    ipcRenderer.send('claude:permission-answer', answer),
  onEvent: (cb: (ev: ClaudeEvent) => void): (() => void) => {
    const handler = (_: unknown, ev: ClaudeEvent): void => cb(ev)
    ipcRenderer.on('claude:event', handler)
    return () => ipcRenderer.removeListener('claude:event', handler)
  },
  onPermission: (cb: (req: PermissionRequest) => void): (() => void) => {
    const handler = (_: unknown, req: PermissionRequest): void => cb(req)
    ipcRenderer.on('claude:permission', handler)
    return () => ipcRenderer.removeListener('claude:permission', handler)
  },
  /** 메인 프로세스가 아직 답을 기다리는 권한 요청 (화면이 다시 로드된 뒤 팝업 복구용) */
  pendingPermissions: (): Promise<PermissionRequest[]> => ipcRenderer.invoke('claude:pending-permissions'),
  /** 답하기 전에 취소된 요청 (작업 중단 등) */
  onPermissionClosed: (cb: (requestId: string) => void): (() => void) => {
    const handler = (_: unknown, requestId: string): void => cb(requestId)
    ipcRenderer.on('claude:permission-closed', handler)
    return () => ipcRenderer.removeListener('claude:permission-closed', handler)
  },

  // 폴더 / 앱
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-folder'),

  // 첨부 파일
  pickFiles: (): Promise<Attachment[]> => ipcRenderer.invoke('dialog:pick-files'),
  /** 끌어다 놓은 File 객체의 실제 경로 (렌더러에서는 file.path 를 쓸 수 없다) */
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  saveClipboardImage: (args: { base64: string; mime: string }): Promise<Attachment> => ipcRenderer.invoke('attach:save-clipboard', args),
  attachmentPreview: (path: string): Promise<string | null> => ipcRenderer.invoke('attach:preview', path),
  // 터미널 패널 (PTY)
  termCreate: (args: { cwd: string; cols?: number; rows?: number }): Promise<TermCreateResult> =>
    ipcRenderer.invoke('term:create', args),
  termWrite: (id: string, data: string): void => ipcRenderer.send('term:write', id, data),
  termResize: (id: string, cols: number, rows: number): void => ipcRenderer.send('term:resize', id, cols, rows),
  termKill: (id: string): Promise<void> => ipcRenderer.invoke('term:kill', id),
  onTermEvent: (cb: (ev: TermEvent) => void): (() => void) => {
    const handler = (_: unknown, ev: TermEvent): void => cb(ev)
    ipcRenderer.on('term:event', handler)
    return () => ipcRenderer.removeListener('term:event', handler)
  },

  // 폴더 패널
  fsList: (dir: string): Promise<FsEntry[]> => ipcRenderer.invoke('fs:list', dir),
  fsRead: (path: string): Promise<FsRead> => ipcRenderer.invoke('fs:read', path),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('fs:reveal', path),
  homeDir: (): Promise<string> => ipcRenderer.invoke('fs:home'),
  isDir: (path: string): Promise<boolean> => ipcRenderer.invoke('fs:is-dir', path),

  defaultCwd: (): Promise<string> => ipcRenderer.invoke('app:default-cwd'),
  hostname: (): Promise<string> => ipcRenderer.invoke('app:hostname'),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('app:open-path', p),

  // 설정
  getConfig: (): Promise<AppConfigView> => ipcRenderer.invoke('config:get'),
  setConfig: (config: AppConfig): Promise<AppConfigView> => ipcRenderer.invoke('config:set', config),
  setApiKey: (key: string | null): Promise<AppConfigView> =>
    ipcRenderer.invoke('config:set-api-key', key),

  // 인증
  loginInTerminal: (): Promise<string> => ipcRenderer.invoke('auth:login-terminal'),
  /** `claude auth status` — 요청 없이 로그인 여부·플랜 확인 */
  authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),

  // MCP
  importClaudeMcp: (cwd: string): Promise<McpServerEntry[]> =>
    ipcRenderer.invoke('mcp:import-claude', cwd),

  // 스킬
  listSkills: (cwd: string): Promise<SkillInfo[]> => ipcRenderer.invoke('skills:list', cwd),
  createSkill: (args: CreateSkillArgs): Promise<SkillInfo> => ipcRenderer.invoke('skills:create', args),
  openSkillsFolder: (scope: SkillScope, cwd: string): Promise<string> =>
    ipcRenderer.invoke('skills:open-folder', scope, cwd),

  // 팀 (직원 에이전트)
  teamStart: (args: TeamStartArgs): Promise<void> => ipcRenderer.invoke('team:start', args),
  teamStop: (taskId: string): Promise<void> => ipcRenderer.invoke('team:stop', taskId),
  teamRunning: (): Promise<string[]> => ipcRenderer.invoke('team:running'),
  teamDispatch: (args: DispatchArgs): Promise<DispatchPlan> => ipcRenderer.invoke('team:dispatch', args),
  onTeamEvent: (cb: (ev: TeamEvent) => void): (() => void) => {
    const handler = (_: unknown, ev: TeamEvent): void => cb(ev)
    ipcRenderer.on('team:event', handler)
    return () => ipcRenderer.removeListener('team:event', handler)
  },

  // 자동 업데이트
  getUpdateStatus: (): Promise<UpdateStatus | null> => ipcRenderer.invoke('update:get-status'),
  checkForUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:download'),
  /** 진행 중인 작업이 있으면 설치하지 않고 이유를 돌려준다. 터미널이 열려 있으면 confirmTerminals 로 다시 불러야 한다 */
  installUpdate: (opts?: { confirmTerminals?: boolean }): Promise<InstallResult> => ipcRenderer.invoke('update:install', opts),
  activeWork: (): Promise<ActiveWork> => ipcRenderer.invoke('app:active-work'),
  updateInfo: (): Promise<{ version: string; packaged: boolean; feed: string; logPath: string; hasToken: boolean }> =>
    ipcRenderer.invoke('update:info'),
  setUpdateToken: (token: string | null): Promise<AppConfigView> =>
    ipcRenderer.invoke('update:set-token', token),
  onUpdateStatus: (cb: (s: UpdateStatus) => void): (() => void) => {
    const handler = (_: unknown, s: UpdateStatus): void => cb(s)
    ipcRenderer.on('update:status', handler)
    return () => ipcRenderer.removeListener('update:status', handler)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
