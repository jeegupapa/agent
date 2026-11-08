// 메인 프로세스와 렌더러가 공유하는 이벤트·설정 타입

export type ToolCallStatus = 'running' | 'done' | 'error' | 'denied'

export interface ToolCallRecord {
  id: string
  name: string
  input: Record<string, unknown>
  status: ToolCallStatus
  startedAt: number
  finishedAt?: number
  result?: string
  isError?: boolean
  /** 서브에이전트(Agent/Task) 안에서 실행된 도구면 부모 Agent 호출 id */
  parentId?: string
  /** Edit/Write 계열: 실행 직전 파일 내용 (새 파일이면 빈 문자열) */
  fileBefore?: string
  /** Edit/Write 계열: 실행 직후 파일 내용 */
  fileAfter?: string
}

export interface UsageSummary {
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  durationMs: number
  numTurns: number
}

/** 구독 플랜의 한도 창 하나 (예: 5시간, 7일) */
export interface PlanWindow {
  type: string
  status: 'allowed' | 'allowed_warning' | 'rejected'
  /** 0 ~ 1 */
  utilization: number
  /** 초기화 시각 (ms epoch) */
  resetsAt?: number
}

/** 세션 시작(init) 시 SDK가 알려주는 연결 상태 */
export interface SessionInfo {
  sessionId: string
  cwd: string
  model: string
  tools: string[]
  /** 'none' 이면 claude.ai 로그인(OAuth), 그 외는 API 키 계열 */
  apiKeySource: string
  mcpServers: { name: string; status: string; source?: string }[]
  slashCommands: string[]
  skills: string[]
  plugins: { name: string; path: string; version?: string }[]
  claudeCodeVersion: string
}

export type ClaudeEvent =
  | { kind: 'session'; info: SessionInfo }
  | { kind: 'text_delta'; text: string }
  | { kind: 'text_done'; text: string }
  | { kind: 'thinking_delta'; text: string }
  | { kind: 'tool_start'; call: ToolCallRecord }
  | { kind: 'tool_result'; id: string; result: string; isError: boolean; fileAfter?: string }
  | { kind: 'result'; usage: UsageSummary; sessionId: string; isError: boolean; errorText?: string }
  | { kind: 'rate_limit'; windows: PlanWindow[]; isUsingOverage: boolean; updatedAt: number }
  | { kind: 'error'; message: string }
  | { kind: 'status'; text: string }

export interface PermissionRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
}

export interface PermissionAnswer {
  requestId: string
  allow: boolean
  always?: boolean
}

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'

export interface SendPromptArgs {
  prompt: string
  cwd: string
  sessionId?: string
  permissionMode: PermissionMode
}

// ---------- 앱 설정 (userData/config.json) ----------

export type McpTransport = 'stdio' | 'http' | 'sse'

export interface McpServerEntry {
  name: string
  enabled: boolean
  type: McpTransport
  /** stdio */
  command?: string
  /** stdio: 공백으로 구분된 인자 문자열을 배열로 보관 */
  args?: string[]
  env?: Record<string, string>
  /** http / sse */
  url?: string
  headers?: Record<string, string>
}

export interface AppConfig {
  auth: {
    /** oauth: claude.ai 로그인(claude login) / apiKey: ANTHROPIC_API_KEY */
    mode: 'oauth' | 'apiKey'
    /** 프록시나 호환 게이트웨이를 쓸 때 ANTHROPIC_BASE_URL */
    baseUrl?: string
  }
  /** 비우면 CLI 기본 모델 */
  model?: string
  /** true 면 ~/.claude 와 프로젝트 .claude 의 설정·MCP·스킬·CLAUDE.md 를 그대로 사용 */
  inheritSettings: boolean
  /** 앱에서 추가로 붙이는 MCP 서버 */
  mcpServers: McpServerEntry[]
  /** 앱 자동 업데이트 */
  update: UpdateConfig
  /** Firebase (세션 기록 저장소) */
  firebase: FirebaseSettings
}

// ---------- Firebase ----------

/** Firebase 콘솔 > 웹 앱 등록에서 받는 공개 설정 (비밀 아님) */
export interface FirebaseWebConfig {
  apiKey: string
  authDomain: string
  projectId: string
  storageBucket?: string
  messagingSenderId?: string
  appId: string
}

export interface FirebaseSettings {
  enabled: boolean
  config?: FirebaseWebConfig
  /** 대화가 한 턴 끝날 때마다 Firestore 에 세션을 저장 */
  saveSessions: boolean
  /** 개발용: "127.0.0.1:9099,127.0.0.1:8080" (Auth, Firestore 에뮬레이터) */
  emulator?: string
  /** Firestore 데이터베이스 ID. 비우면 "(default)". 콘솔에서 이름을 붙여 만들었으면 그 이름 */
  databaseId?: string
}

/** Firestore users/{uid}/sessions/{id} 문서 */
export interface SavedSessionMeta {
  id: string
  title: string
  cwd: string
  model?: string
  createdAt: number
  updatedAt: number
  numTurns: number
  /** 저장한 PC 이름 (다른 PC 에서는 이어가기 불가 안내용) */
  host: string
}

// ---------- 앱 자동 업데이트 ----------

export interface UpdateConfig {
  /** 시작 시 그리고 주기적으로 업데이트 확인 */
  autoCheck: boolean
  /** 새 버전이 있으면 묻지 않고 바로 내려받기 */
  autoDownload: boolean
  /** 내려받은 업데이트를 앱 종료 시 자동 설치 */
  installOnQuit: boolean
  /** generic: latest.yml 이 올라간 폴더 URL / github: Releases */
  provider: 'generic' | 'github'
  url?: string
  owner?: string
  repo?: string
}

export type UpdateState =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error'

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  /** 새 버전 번호 (available 이후) */
  version?: string
  releaseNotes?: string
  releaseDate?: string
  /** 0 ~ 100 */
  percent?: number
  bytesPerSecond?: number
  transferred?: number
  total?: number
  error?: string
  /** 마지막 확인 시각 */
  checkedAt?: number
}

export interface AppConfigView extends AppConfig {
  /** 암호화 저장된 API 키 존재 여부 (키 자체는 렌더러로 보내지 않음) */
  hasApiKey: boolean
  /** 키 끝 4자리 (표시용) */
  apiKeyHint?: string
}

export const DEFAULT_UPDATE_CONFIG: UpdateConfig = {
  autoCheck: true,
  autoDownload: true,
  installOnQuit: true,
  provider: 'generic',
  url: ''
}

/**
 * 기본 Firebase 프로젝트 (agent-da912). 웹 앱용 공개 설정이라 비밀이 아니며,
 * 보안은 Firestore 규칙(firestore.rules)과 로그인으로 지킨다. 설정 창에서 다른 프로젝트로 바꿀 수 있다.
 */
export const DEFAULT_FIREBASE_CONFIG: FirebaseWebConfig = {
  apiKey: 'AIzaSyDZH1Vcl0uchRyruKkc_TUha9OodFGTrfc',
  authDomain: 'agent-da912.firebaseapp.com',
  projectId: 'agent-da912',
  storageBucket: 'agent-da912.firebasestorage.app',
  messagingSenderId: '940401045515',
  appId: '1:940401045515:web:a27b10dc41c671323a970e'
}

export const DEFAULT_FIREBASE_SETTINGS: FirebaseSettings = {
  enabled: true,
  saveSessions: true,
  config: DEFAULT_FIREBASE_CONFIG,
  // 콘솔에서 "(default)" 가 아닌 "default" 라는 이름으로 만들어진 데이터베이스
  databaseId: 'default'
}

export const DEFAULT_CONFIG: AppConfig = {
  auth: { mode: 'oauth' },
  inheritSettings: true,
  mcpServers: [],
  update: DEFAULT_UPDATE_CONFIG,
  firebase: DEFAULT_FIREBASE_SETTINGS
}

// ---------- 스킬 ----------

export type SkillScope = 'user' | 'project'

export interface SkillInfo {
  name: string
  description: string
  scope: SkillScope
  path: string
}

export interface CreateSkillArgs {
  scope: SkillScope
  cwd: string
  name: string
  description: string
  body: string
}
