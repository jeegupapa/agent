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

/** `claude auth status` 결과. 요청을 보내지 않아도 로그인 여부와 플랜 종류를 알 수 있다 */
export interface AuthStatus {
  loggedIn: boolean
  /** claude.ai / console 등 */
  authMethod?: string
  email?: string
  /** max / pro / team / enterprise … */
  subscriptionType?: string
  loginExpiresAt?: string
  orgName?: string
  /** 확인 실패 시 메시지 */
  error?: string
  checkedAt: number
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

/** 보고서에 대한 사용자의 응답: 승인 / 수정 요청 / 확인 요청에 대한 답변 */
export type ReviewDecision = 'approved' | 'changes_requested' | 'answered'

export interface TaskReview {
  at: number
  decision: ReviewDecision
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
  /** 채팅창 요청을 팀장이 배분해 만든 작업이면 그 요청 id. 보고가 채팅으로 돌아간다 */
  origin?: { kind: 'chat'; requestId: string }
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
  /** 사용자 메모리(renderMemory 결과). 직원 지시문 뒤에 붙는다 */
  memory?: string
}

// ---------- 첨부 파일 ----------

/** 채팅에 첨부한 파일. 경로를 프롬프트에 적어 주면 Claude Code 가 Read 도구로 읽는다(이미지·PDF 포함) */
export interface Attachment {
  name: string
  path: string
  size?: number
  /** image/png 등. 모르면 비움 */
  mime?: string
}

// ---------- 메모리 (채팅에서 "기억해" 로 저장한 내용) ----------

/** 사용자가 저장한 메모리 한 건. 세션 시작 시 시스템 프롬프트에 붙어 Claude 가 참고한다 */
export interface MemoryItem {
  id: string
  text: string
  /** global: 모든 폴더에서 / project: cwd 폴더에서만 */
  scope: 'global' | 'project'
  cwd?: string
  enabled: boolean
  /** 어디서 만들었는지 */
  source?: { kind: 'chat' | 'command' | 'manual'; sessionId?: string; sessionTitle?: string }
  createdAt: number
  updatedAt: number
}

// ---------- 팀장 배분 (채팅 요청 → 직원 작업) ----------

/** 팀장이 만든 작업 하나. 기존 직원(employeeId) 또는 템플릿 채용(presetRole) 중 하나를 가리킨다 */
export interface DispatchAssignment {
  employeeId?: string
  /** 맞는 직원이 없을 때 EMPLOYEE_PRESETS 의 role 로 새 직원을 채용 */
  presetRole?: string
  title: string
  instructions: string
}
export interface DispatchPlan {
  /** 사용자에게 보여줄 배분 요약 (한두 문장) */
  summary: string
  assignments: DispatchAssignment[]
  /** 직원에게 맡길 일이 아닐 때(질문·잡담) 팀장이 직접 한 답 */
  directAnswer?: string
}
export interface DispatchArgs {
  request: string
  cwd: string
  employees: Pick<Employee, 'id' | 'name' | 'role' | 'specialty'>[]
  /** 팀장이 쓸 모델 (비우면 기본 모델) */
  model?: string
  /** 사용자 메모리. 배분할 때 참고 */
  memory?: string
}

/** 바로 쓸 수 있는 직원 템플릿 */
export const EMPLOYEE_PRESETS: Omit<Employee, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: '수아',
    role: '프로덕트 매니저 (PM)',
    emoji: '🧭',
    color: '#d97757',
    specialty: '요구사항 정리, 우선순위, 일정과 범위 관리',
    instructions:
      '당신은 프로덕트 매니저입니다. 코드를 직접 고치지 말고, 요청을 사용자 관점의 문제 정의 → 목표 → 범위(포함/제외) → 완료 기준(검수 가능한 문장) → 우선순위로 정리하세요. 코드베이스를 읽어 현재 동작과 제약을 확인한 뒤, 작업 단위(각 1~2시간 분량)로 쪼개고 어떤 직원(프론트/백엔드/QA 등)에게 맡길지 제안합니다. 결과는 docs/ 아래 마크다운 문서로 저장하고, 모호한 요구는 추측하지 말고 "확인 요청"에 질문으로 남기세요.',
    permissionMode: 'acceptEdits'
  },
  {
    name: '예준',
    role: '기획자 (Planner)',
    emoji: '🧩',
    color: '#2bb3c0',
    specialty: '구현 계획, 작업 분해, 순서와 의존성 정리',
    instructions:
      '당신은 구현 기획자입니다. 코드를 수정하지 말고 계획만 세우세요. 관련 파일과 함수를 실제로 읽어 영향 범위를 파악한 뒤, 단계별 계획을 작성합니다: 각 단계마다 수정할 파일, 변경 내용, 검증 방법, 롤백 방법을 적고 의존 관계와 권장 순서를 표시하세요. 위험한 부분(데이터 마이그레이션, 공개 API 변경 등)은 따로 표시합니다. 계획은 docs/plans/ 아래 마크다운으로 저장하고, 선택지가 갈리는 지점은 장단점과 함께 추천안을 제시하세요.',
    permissionMode: 'acceptEdits'
  },
  {
    name: '시우',
    role: '아키텍트',
    emoji: '📐',
    color: '#8b93a5',
    specialty: '구조 설계, 모듈 경계, 기술 선택과 트레이드오프',
    instructions:
      '당신은 소프트웨어 아키텍트입니다. 코드를 직접 수정하지 말고 설계를 담당하세요. 현재 구조(모듈, 의존 방향, 데이터 흐름)를 먼저 파악해 그림이나 목록으로 정리하고, 요청에 대해 2~3개의 설계안을 트레이드오프(복잡도, 성능, 확장성, 마이그레이션 비용)와 함께 비교한 뒤 하나를 추천합니다. 결정은 ADR 형식(배경 → 결정 → 근거 → 결과)으로 docs/adr/ 아래에 저장하세요. 인터페이스와 타입 시그니처는 코드 블록으로 구체적으로 제시합니다.',
    permissionMode: 'acceptEdits'
  },
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
  },
  {
    name: '서준',
    role: '보안 엔지니어',
    emoji: '🔐',
    color: '#e5534b',
    specialty: '취약점 점검, 비밀 정보 노출, 의존성 보안',
    instructions:
      '당신은 애플리케이션 보안 엔지니어입니다. 파일을 수정하지 말고 점검과 보고만 하세요. 입력 검증, 인증·인가, 비밀 정보(키·토큰) 하드코딩, 인젝션, 경로 탐색, 안전하지 않은 역직렬화, 과한 권한, 의존성 취약점(npm audit 등 실행 가능하면 실행)을 확인합니다. 발견 사항은 심각도(치명/높음/중간/낮음), 위치(파일·줄), 공격 시나리오, 수정 방법 순으로 적고, 확인되지 않은 추측은 "추정"으로 표시하세요. 실제 공격 코드는 작성하지 않습니다.',
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
**남은 문제 / 확인 요청**: (없으면 "없음". 있으면 한 건에 한 줄씩 번호 목록으로)
- 지시가 모호하면 추측으로 크게 바꾸지 말고, 가장 안전한 해석으로 진행한 뒤 보고서의 "확인 요청"에 질문을 적으세요.
- 확인 요청은 사용자가 항목마다 바로 답할 수 있게, 무엇을 정해 달라는지와 선택지를 한 줄에 담아 쓰세요.
- "확인 요청에 대한 답변"을 받으면 그 답을 기준으로 이어서 진행하고, 답이 없는 항목은 가장 안전한 쪽으로 판단하세요.
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
  /**
   * resume 에 쓸 Claude Code 세션 id. 문서 id 는 앱이 만든 값이라 따로 둔다
   * (팀에게 맡기기만 한 대화처럼 Claude 세션이 없을 수도 있다). 없으면 예전 문서: id 가 곧 Claude 세션 id
   */
  claudeSessionId?: string
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

// ---------- 터미널 / 폴더 패널 ----------

/** 메인 → 렌더러: PTY 출력과 종료 */
export type TermEvent =
  | { kind: 'data'; id: string; data: string }
  | { kind: 'exit'; id: string; exitCode: number }

export interface TermCreateResult {
  id: string
  /** pwsh, powershell, bash 등 */
  shell: string
  cwd: string
}

/** 폴더 패널의 한 항목 */
export interface FsEntry {
  name: string
  path: string
  isDir: boolean
  size?: number
  mtime?: number
}

/** 폴더 패널 미리보기용 파일 내용 */
export type FsRead =
  | { kind: 'text'; text: string; truncated: boolean; size: number }
  | { kind: 'image'; dataUrl: string; size: number }
  | { kind: 'binary'; size: number }
  | { kind: 'error'; message: string }
