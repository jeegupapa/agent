import { contextBridge, ipcRenderer } from 'electron'
import type {
  AppConfig,
  AppConfigView,
  ClaudeEvent,
  CreateSkillArgs,
  McpServerEntry,
  PermissionAnswer,
  PermissionRequest,
  SendPromptArgs,
  SkillInfo,
  SkillScope,
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

  // 폴더 / 앱
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:pick-folder'),
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

  // MCP
  importClaudeMcp: (cwd: string): Promise<McpServerEntry[]> =>
    ipcRenderer.invoke('mcp:import-claude', cwd),

  // 스킬
  listSkills: (cwd: string): Promise<SkillInfo[]> => ipcRenderer.invoke('skills:list', cwd),
  createSkill: (args: CreateSkillArgs): Promise<SkillInfo> => ipcRenderer.invoke('skills:create', args),
  openSkillsFolder: (scope: SkillScope, cwd: string): Promise<string> =>
    ipcRenderer.invoke('skills:open-folder', scope, cwd),

  // 자동 업데이트
  getUpdateStatus: (): Promise<UpdateStatus | null> => ipcRenderer.invoke('update:get-status'),
  checkForUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:check'),
  downloadUpdate: (): Promise<UpdateStatus> => ipcRenderer.invoke('update:download'),
  installUpdate: (): Promise<void> => ipcRenderer.invoke('update:install'),
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
