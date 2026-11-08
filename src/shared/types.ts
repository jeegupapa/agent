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
  /** Agent/Task 호출: 서브에이전트 진행 정보 (SDK task_* 메시지) */
  subagent?: SubagentInfo
}

/** 서브에이전트(Agent/Task) 진행 정보 */
export interface SubagentInfo {
  description?: string
  subagentType?: string
  /** 서브에이전트에게 준 전체 지시문 */
  prompt?: string
  status?: 'running' | 'completed' | 'failed' | 'stopped'
  /** 모델이 만든 진행 요약 (최신) / 완료 후에는 최종 요약 */
  summary?: string
  lastTool?: string
  totalTokens?: number
  toolUses?: number
  durationMs?: number
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
  | { kind: 'subagent_info'; parentId: string; info: SubagentInfo }
  | { kind: 'result'; usage: UsageSummary; sessionId: string; isError: boolean; errorText?: string }
  | { kind: 'rate_limit'; windows: PlanWindow[]; isUsingOverage: boolean; updatedAt: number }
  | { kind: 'error'; message: string }
  | { kind: 'status'; text: string }

export interface PermissionRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  /** 팀 작업에서 온 요청이면 해당 작업 id */
  taskId?: string
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
  /** Claude Code 기본 시스템 프롬프트 뒤에 덧붙일 역할 지시문 (직원용) */
  systemPromptAppend?: string
  /** 비우면 CLI 기본 모델 */
  model?: string
  /** 허용 도구 목록 (비우면 전부) */
  allowedTools?: string[]
  disallowedTools?: string[]
  maxTurns?: number
}

// ---------- 팀 (직원 에이전트) ----------

/** 역할과 지시문을 가진 직원 에이전트 정의 */
export interface Employee {
  id: string
  name: string
  /** 직함 (예: 프론트엔드 개발자) */
  role: string
  /** 아바타용 이모지 */
  emoji: string
  color: string
  /** 전문 분야 한 줄 설명 */
  specialty: string
  /** 역할 지시문. Claude Code 기본 프롬프트 뒤에 덧붙는다 */
  instructions: string
  model?: string
  permissionMode: PermissionMode
  /** 기본 작업 폴더 (비우면 작업 지시 때 지정) */
  defaultCwd?: string
  createdAt: number
  updatedAt: number
}

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_permission'
  | 'needs_review'
  | 'approved'
  | 'changes_requested'
  | 'failed'
  | 'stopped'

export interface TaskReview {
  at: number
  decision: 'approved' | 'changes_requested'
  comment?: string
}

/** 직원에게 지시한 작업 하나 */
export interface TeamTask {
  id: string
  employeeId: string
  title: string
  instructions: string
  cwd: string
  status: TaskStatus
  createdAt: number
  startedAt?: number
  finishedAt?: number
  /** 이어서 지시(수정 요청)할 때 resume 에 쓰는 세션 id */
  sessionId?: string
  /** 진행 요약 */
  progress: {
    toolUses: number
    lastTool?: string
    /** 마지막 어시스턴트 텍스트 일부 */
    lastText?: string
    updatedAt?: number
    numTurns?: number
    totalTokens?: number
    costUsd?: number
  }
  /** 작업이 끝났을 때 직원이 남긴 최종 보고 (마지막 어시스턴트 메시지) */
  report?: string
  error?: string
  reviews: TaskReview[]
  /** 수정 요청 횟수 */
  round: number
}

/** 메인 프로세스 → 렌더러: 팀 작업 이벤트 (ClaudeEvent 에 taskId 를 붙인 것) */
export interface TeamEvent {
  taskId: string
  event: ClaudeEvent
}

export interface TeamStartArgs {
  task: TeamTask
  employee: Employee
  /** 수정 요청 등 추가 지시. 있으면 이것을 프롬프트로 쓰고 세션을 이어간다 */
  followUp?: string
}

/** 바로 쓸 수 있는 직원 템플릿 */
export const EMPLOYEE_PRESETS: Omit<Employee, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: '민준',
    role: '프론트엔드 개발자',
    emoji: '🎨',
    color: '#5b8def',
    specialty: 'React / TypeScript / CSS. 접근성과 반응형을 챙기는 UI 구현',
    instructions:
      '당신은 시니어 프론트엔드 개발자입니다. 기존 코드 스타일과 컴포넌트 구조를 먼저 파악한 뒤 작업하세요. UI 변경은 접근성(키보드·명도 대비)과 반응형을 확인합니다. 타입 오류가 없게 하고, 가능하면 빌드나 타입체크를 실행해 검증하세요.',
    permissionMode: 'acceptEdits'
  },
  {
    name: '서연',
    role: '백엔드 개발자',
    emoji: '🛠️',
    color: '#4caf7d',
    specialty: 'API, 데이터 모델, 성능과 에러 처리',
    instructions:
      '당신은 시니어 백엔드 개발자입니다. 입력 검증, 에러 처리, 로깅을 빠뜨리지 말고, 외부 호출에는 타임아웃을 두세요. 변경 전후로 테스트를 실행하고 결과를 보고에 포함하세요.',
    permissionMode: 'acceptEdits'
  },
  {
    name: '도윤',
    role: 'QA 엔지니어',
    emoji: '🔍',
    color: '#e3b341',
    specialty: '테스트 설계, 버그 재현, 회귀 테스트',
    instructions:
      '당신은 QA 엔지니어입니다. 코드를 수정하기보다 테스트를 작성·실행하고 문제를 재현해 보고하세요. 발견한 버그는 재현 절차, 기대 결과, 실제 결과를 적습니다. 수정은 명시적으로 요청받았을 때만 합니다.',
    permissionMode: 'default'
  },
  {
    name: '하은',
    role: '테크니컬 라이터',
    emoji: '📝',
    color: '#c678dd',
    specialty: 'README, API 문서, 변경 이력',
    instructions:
      '당신은 테크니컬 라이터입니다. 코드를 읽고 정확한 문서를 작성합니다. 과장하지 말고 실제 동작만 적으세요. 한국어로 쓰되 식별자는 원문 그대로 둡니다. 문서 파일 외의 코드는 수정하지 않습니다.',
    permissionMode: 'acceptEdits'
  },
  {
    name: '지호',
    role: '코드 리뷰어',
    emoji: '🧐',
    color: '#e5534b',
    specialty: '버그·보안·성능 관점의 코드 리뷰',
    instructions:
      '당신은 코드 리뷰어입니다. 파일을 수정하지 말고 읽기만 하세요. 심각도(높음/중간/낮음)별로 문제를 정리하고 파일 경로와 줄 번호, 왜 문제인지, 어떻게 고칠지를 적습니다. 스타일 취향보다 실제 결함에 집중하세요.',
    permissionMode: 'default'
  }
]

/** 모든 직원 지시문 뒤에 공통으로 붙는 보고 규칙 */
export const TEAM_REPORT_RULES = `

## 보고 규칙
- 작업을 마치면 마지막 메시지를 반드시 아래 형식의 보고서로 끝내세요.
## 보고
**한 일**: (3줄 이내 요약)
**변경한 파일**: (경로 목록, 없으면 "없음")
**검증**: (실행한 테스트·빌드와 결과)
**남은 문제 / 확인 요청**: (없으면 "없음")
- 지시가 모호하면 추측으로 크게 바꾸지 말고, 가장 안전한 해석으로 진행한 뒤 보고서의 "확인 요청"에 질문을 적으세요.
- 사용자는 보고서만 읽고 승인 여부를 결정하므로, 보고서는 그 자체로 이해되게 쓰세요.`


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
  /** 비공개 GitHub 저장소 업데이트용 토큰 저장 여부 (토큰 자체는 렌더러로 보내지 않음) */
  hasUpdateToken: boolean
}

export const DEFAULT_UPDATE_CONFIG: UpdateConfig = {
  autoCheck: true,
  autoDownload: true,
  installOnQuit: true,
  // owner/repo 를 비우면 빌드에 포함된 기본 배포 위치(package.json build.publish)를 쓴다
  provider: 'github'
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
