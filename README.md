# Claude CLI Studio

Claude Code CLI를 감싸서 시각화하는 Windows 데스크톱 앱입니다.
Electron + React + TypeScript로 만들었고, Claude Code 엔진은 공식 **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`)로 연결합니다.

## 화면 구성

| 영역 | 내용 |
|---|---|
| 왼쪽 사이드바 | 작업 폴더 선택, 모델·세션 ID, 권한 모드(기본 / 편집 자동 승인 / 플랜 / 모두 허용), **플랜 사용량**(5시간·주간 한도 % 와 초기화까지 남은 시간), 이번 세션의 턴 수·토큰 |
| 가운데 채팅 | 사용자 메시지, 스트리밍되는 Claude 답변(**마크다운 렌더링**, GFM 표·체크박스, **코드 하이라이트**와 복사 버튼), 도구 호출 칩(클릭하면 오른쪽 패널로 이동; Agent 칩에는 서브에이전트가 쓴 도구 수 표시) |
| 오른쪽 패널 | **도구 호출** 탭: 호출 순서·입력·결과·소요 시간, 서브에이전트(Agent/Task) 안의 도구는 부모 아래 **트리**로 접고 펼치기, Agent 호출 상세에서 서브에이전트의 **진행 상황**(유형, 모델이 쓴 진행 요약, 도구 수·토큰·시간, 마지막 도구, 지시문) 보기 / **변경 사항** 탭: Edit·Write 호출을 **전체 파일 기준 diff**(실행 전후 스냅샷, 변경 주변 3줄만 보이고 나머지는 접힘, +/- 줄 수)와 **변경 부분**(old/new) 두 모드로 표시 |
| 패널 조절 | 사이드바·채팅·도구 패널 사이의 경계를 드래그해 너비 조절(더블클릭으로 기본값), 채팅 위 모서리 버튼이나 Ctrl+B(사이드바) / Ctrl+J(도구 패널)로 숨기기·보이기. 도구 칩을 클릭하거나 파일 편집이 시작되면 숨겨진 도구 패널이 자동으로 열립니다. 설정은 localStorage 에 저장 |
| 권한 다이얼로그 | Claude가 명령 실행이나 파일 수정을 하려 할 때 명령어 또는 diff를 보여주고 허용 / 항상 허용 / 거부 |
| 연결 설정 (사이드바 "연결" → API·인증 / MCP / 스킬) | 아래 "연결 설정" 참고 |
| 자동 업데이트 (사이드바 맨 아래 버전 표시 / 설정 "업데이트" 탭) | 아래 "자동 업데이트" 참고 |
| 세션 기록 (사이드바 "세션 기록" / 설정 "Firebase" 탭) | Firestore 에 대화·도구 호출·사용량을 저장하고 불러오기. 아래 "Firebase 세션 기록" 참고 |

## 연결 설정

### API · 인증
- **claude.ai 구독 로그인(기본)**: "터미널에서 로그인 열기" 버튼이 새 콘솔에서 `claude login` 을 실행합니다. Pro/Max 플랜 한도를 쓰고 사이드바에 플랜 사용량이 표시됩니다.
- **Anthropic API 키**: 키를 입력하면 Windows 자격 증명 저장소(DPAPI)로 암호화해 `%APPDATA%\claude-cli-studio\apikey.bin` 에 보관합니다. 화면에는 끝 4자리만 보입니다. 자식 프로세스에 `ANTHROPIC_API_KEY` 로 전달됩니다.
- **기본 URL**: 프록시나 호환 게이트웨이를 쓸 때 `ANTHROPIC_BASE_URL` 로 전달됩니다.
- **모델**: 비우면 CLI 기본값.
- **Claude Code 설정 상속**: 켜면 `~/.claude` 와 프로젝트 `.claude` 의 settings.json, CLAUDE.md, MCP 서버(`~/.claude.json`, `.mcp.json`), 스킬, 플러그인을 터미널 CLI 와 동일하게 불러옵니다(SDK `settingSources: ['user','project','local']`). 끄면 앱에서 등록한 MCP 서버만 씁니다.

### MCP 서버
- stdio(로컬 명령) / http / sse 서버를 추가·편집·켜고 끌 수 있습니다. 설정은 `%APPDATA%\claude-cli-studio\config.json` 에 저장됩니다.
- "Claude Code 설정에서 가져오기"는 `~/.claude.json` 의 전역·프로젝트 MCP 서버를 앱 목록으로 복사합니다.
- 세션이 시작되면 각 서버의 연결 상태(connected / failed / needs-auth)가 목록과 사이드바에 표시됩니다. 상속으로 들어온 서버는 점선 테두리로 구분합니다.

### 스킬
- 사용자 전역(`~/.claude/skills`)과 프로젝트(`.claude/skills`)의 `SKILL.md` 를 읽어 목록으로 보여 줍니다.
- "새 스킬 만들기"로 이름·설명·지침을 적으면 프런트매터가 포함된 SKILL.md 를 생성합니다.
- "채팅에 넣기"를 누르거나 입력창에 `/` 를 치면 세션이 제공하는 슬래시 명령(스킬 포함)이 자동완성됩니다. ↑↓ 로 고르고 Tab 또는 Enter 로 확정합니다.

## Firebase 세션 기록

Firebase(Authentication + Firestore)를 데이터베이스로 써서 세션 기록을 저장합니다. 끄면 아무것도 저장하지 않습니다.

### 준비 (Firebase 콘솔, 무료 Spark 플랜으로 충분)
1. 프로젝트 만들기 → 웹 앱(</>) 추가 → `firebaseConfig` 복사
2. Authentication → 로그인 방법 → **이메일/비밀번호** 사용 설정
3. Firestore Database → 데이터베이스 만들기 (프로덕션 모드, 리전은 `asia-northeast3` 권장).
   Realtime Database 와는 별개 제품이라 Firestore 를 따로 만들어야 합니다 (없으면 저장이 `NOT_FOUND` 로 계속 재시도만 함).
   데이터베이스 ID 를 `(default)` 가 아닌 이름으로 만들었다면 앱의 Firebase 탭 "Firestore 데이터베이스 ID" 에 그 이름을 적습니다
4. Firestore → 규칙 탭에 이 저장소의 [`firestore.rules`](firestore.rules) 내용을 붙여넣고 게시
   (또는 `firebase deploy --only firestore:rules`)

### 앱에서
- 기본 프로젝트(`agent-da912`)의 `firebaseConfig` 가 앱에 내장되어 있어 바로 로그인할 수 있습니다. 다른 프로젝트를
  쓰려면 설정 → **Firebase** 탭에 `firebaseConfig` 를 그대로 붙여넣습니다 (`const firebaseConfig = {…}` 형태도 됨).
  공개 식별자라 비밀이 아니며 `config.json` 에 저장됩니다.
- 이메일·비밀번호로 "계정 만들기" 또는 "로그인" 후 저장합니다. 로그인 상태는 앱을 껐다 켜도 유지됩니다.
- 이후 대화가 한 턴 끝날 때마다 `users/{uid}/sessions/{세션ID}` 문서에 제목(첫 메시지), 작업 폴더, 모델,
  메시지, 도구 호출(결과는 6,000자까지), 사용량, 저장한 PC 이름을 저장합니다. 문서가 900KB 를 넘으면 도구 결과를
  생략합니다.
- 사이드바 **세션 기록**에 최근 40개가 최신순으로 실시간 표시됩니다. 4개 이상이면 제목·폴더 검색창과 "이 폴더만" 필터가 나타납니다. 클릭하면 대화·도구 호출·변경 사항이 그대로
  복원되고, 같은 PC 라면 이어서 대화할 수 있습니다. 다른 PC 에서 만든 세션은 읽기 전용으로 열리며 새 메시지를
  보내면 자동으로 새 세션으로 시작합니다. ✕ 로 기록을 삭제합니다.
- 보안 규칙은 로그인한 사용자가 자기 `users/{uid}` 아래 문서만 읽고 쓰도록 제한합니다. Auth·Firestore
  에뮬레이터(`127.0.0.1:9099,127.0.0.1:8080`)로 등록·저장·목록·불러오기·삭제·규칙 차단을 검증했습니다.
- 개발용: Firebase 탭 → "에뮬레이터" 에 호스트를 적으면 실제 프로젝트 대신 로컬 에뮬레이터에 붙습니다.
- 렌더러의 CSP(`src/renderer/index.html`)가 `connect-src` 로 `*.googleapis.com`, `*.firebaseapp.com`, `*.firebaseio.com`
  과 127.0.0.1/localhost(에뮬레이터)를 허용합니다. 여기 없는 주소로는 요청이 막혀 `auth/network-request-failed` 가 납니다.

## 자동 업데이트

electron-updater 로 앱 자체를 자동 업데이트합니다. 기본 배포 위치는 **GitHub Releases
(`jeegupapa/agent`)** 이며, 태그를 푸시하면 GitHub Actions 가 설치 파일을 빌드해 Release 에 올립니다.

### 비공개 저장소일 때
저장소가 비공개면 설치된 앱이 로그인 없이는 Release 를 읽지 못해 `404 … releases.atom` 오류가 납니다. 두 가지 중 하나를 고릅니다.
- **저장소를 공개로 전환** (GitHub → Settings → Danger Zone → Change visibility). 설정 없이 바로 동작합니다.
- **토큰 사용**: GitHub → Settings → Developer settings → Fine-grained tokens 에서 이 저장소의 *Contents: Read-only*
  권한만 가진 토큰을 만들어, 앱 설정 → 업데이트 → "GitHub 토큰" 에 넣습니다. 토큰은 DPAPI 로 암호화되어
  `%APPDATA%\claude-cli-studio\ghtoken.bin` 에 저장되고, electron-updater 가 GitHub API 로 Release 를 읽어 받습니다.
  PC 마다 한 번씩 넣어야 합니다.

### 설치 파일 이름에 공백이 없어야 하는 이유
GitHub 는 첨부 파일 이름의 공백을 점으로 바꿔 저장하지만 electron-builder 의 `latest.yml` 은 하이픈으로 바꿔 적기 때문에,
`Claude CLI Studio-Setup-x.y.z.exe` 처럼 공백이 있으면 설치된 앱이 파일을 찾지 못해 404 가 납니다.
그래서 `artifactName` 을 `Claude-CLI-Studio-Setup-${version}.${ext}` 로 고정했습니다.

### 새 버전 배포
```bash
# 1. package.json 의 version 을 올린다 (예: 0.3.0)
git commit -am "v0.3.0"
git tag v0.3.0
git push && git push --tags
```
`.github/workflows/release.yml` 이 Windows 러너에서 `npm ci` → 타입체크 → `electron-builder --publish always` 를
실행해 Release `v0.3.0` 에 `Claude CLI Studio-Setup-0.3.0.exe`, `.blockmap`, `latest.yml` 을 첨부합니다.
Release 가 게시되면 설치된 앱이 다음 확인 때 자동으로 받습니다. (태그와 package.json 버전이 다르면 빌드가 실패합니다.)

- 앱 시작 4초 뒤와 이후 4시간마다 새 버전을 확인합니다(설정에서 끌 수 있음).
- 새 버전이 있으면 기본적으로 바로 내려받고, 사이드바 상단 배너에 진행률을 보여 줍니다. 다운로드가 끝나면
  "재시작하고 설치" 버튼이 나타나며, 누르지 않아도 앱을 닫을 때 자동 설치됩니다(설정으로 변경 가능).
- 배포 위치는 `package.json` → `build.publish` 가 기본이고, 설정 창 "업데이트" 탭에서 다른 곳으로 바꿀 수 있습니다.
  - **GitHub Releases**: owner / repo (기본 `jeegupapa` / `agent`)
  - **정적 URL**: `latest.yml`, `Claude CLI Studio-Setup-x.y.z.exe`, `.exe.blockmap` 세 파일을 올린 폴더 주소.
    로컬에서 `npm run dist` 로 만든 `release/` 의 세 파일을 직접 올려도 됩니다.
- `.blockmap` 덕분에 이전 버전과 달라진 부분만 받는 differential download 가 됩니다.
- 확인·다운로드 로그는 설정 "업데이트" 탭의 "업데이트 로그 열기"로 볼 수 있습니다
  (`%APPDATA%\claude-cli-studio\logs\main.log`).
- 개발 모드(`npm run dev`)에서는 배포 위치가 없어 "미설정"으로 표시됩니다. 설정 탭에서 주소를 넣으면 확인·다운로드까지
  테스트할 수 있고, 설치는 설치판에서만 됩니다.

## 사전 준비

1. Node.js 20 이상
2. Claude Code 로그인 상태. 터미널에서 한 번 로그인해 두면 앱이 같은 자격 증명을 씁니다.

```bash
claude login
```

## 실행

```bash
npm install
npm run dev
```

`npm run dev` 는 Vite 개발 서버와 Electron 창을 함께 띄우며, 렌더러 코드는 저장 즉시 반영됩니다.

## 빌드

```bash
npm run build        # out/ 폴더에 번들 생성
npx electron .       # 번들로 실행
npm run dist         # Windows 설치 파일(nsis) + latest.yml + blockmap 생성 → release/
```

## 구조

```
src/
  main/
    index.ts      Electron 창 생성, IPC 핸들러 (설정·인증·MCP 가져오기·스킬)
    claude.ts     Agent SDK query() 래퍼 → ClaudeEvent 스트림으로 변환, 권한 요청 중계,
                  설정(인증 env, MCP 서버, settingSources, 모델)을 SDK 옵션으로 변환
    config.ts     config.json 저장소와 API 키 암호화(safeStorage)
    updater.ts    electron-updater 래퍼 (피드 설정, 확인·다운로드·설치, 상태 push)
    skills.ts     SKILL.md 스캔·생성
  preload/
    index.ts      window.api (렌더러 ↔ 메인 브리지)
  renderer/
    src/App.tsx           상태 관리, 이벤트 → UI 반영, Firebase 세션 저장/복원
    src/firebase.ts       Firebase Auth/Firestore 연결, 세션 저장·목록·불러오기, firebaseConfig 파서
    src/components/
      Sidebar.tsx         폴더·세션·권한 모드·사용량
      Chat.tsx            메시지 목록과 입력창
      ToolChip.tsx        채팅 안의 도구 호출 표시
      ToolLog.tsx         도구 호출 목록과 상세
      DiffPanel.tsx       Edit/Write 를 라인 diff로 렌더링
      PermissionDialog.tsx 권한 요청 모달
      SettingsDialog.tsx  연결 설정 (API·인증 / MCP 서버 / 스킬 / 업데이트 탭)
      UpdatePanel.tsx     업데이트 배너·설정 탭
      FirebasePanel.tsx   세션 기록 목록·Firebase 설정 탭
  shared/types.ts   메인·렌더러가 공유하는 이벤트 타입
```

## 동작 원리

1. 렌더러가 `window.api.send({ prompt, cwd, sessionId, permissionMode })` 를 호출합니다.
2. 메인 프로세스의 `ClaudeRunner` 가 Agent SDK `query()` 를 실행합니다. SDK는 함께 설치된
   `claude.exe` 를 자식 프로세스로 띄우고 JSON 이벤트를 스트리밍합니다.
3. `stream_event` 의 텍스트 델타는 `text_delta` 로, `tool_use` 블록은 `tool_start` 로,
   `tool_result` 는 `tool_result` 로 변환해 IPC로 보냅니다.
4. SDK가 `canUseTool` 을 호출하면 메인은 렌더러에 `claude:permission` 을 보내고,
   사용자가 다이얼로그에서 고른 답을 받아 SDK에 돌려줍니다.
5. `rate_limit_event` 메시지(구독 사용자에게만 옴)의 `unifiedWindows` 를 읽어 5시간·주간 한도의
   사용률과 초기화 시각을 사이드바 "플랜 사용량"에 막대로 표시합니다. 달러 비용은 API 종량제 환산
   추정치라서 구독 플랜에서는 참고용으로만 "토큰 상세 보기" 안에 넣었습니다.
6. `result` 메시지의 턴 수·토큰·소요 시간을 "이번 세션"에 표시합니다.
7. 응답마다 받은 `session_id` 를 다음 요청의 `resume` 에 넣어 대화를 이어갑니다.
8. Edit/Write/MultiEdit/NotebookEdit 호출이 보이면 메인 프로세스가 대상 파일을 실행 직전에 한 번(`fileBefore`),
   `tool_result` 가 오면 다시 한 번(`fileAfter`) 읽어 둡니다(1MB 이하 텍스트 파일만). 변경 사항 탭은 이 둘을
   비교해 전체 파일 diff 를 그립니다. 스냅샷은 Firestore 에는 저장하지 않습니다.
9. 서브에이전트(Agent/Task) 안의 도구 호출은 `stream_event` 로 오지 않고 `parent_tool_use_id` 가 붙은 완성된
   `assistant` 메시지로만 오므로, 그 블록에서 `tool_start` 를 만들고 `parentId` 를 붙여 트리로 보여 줍니다.
   서브에이전트의 최종 답변은 Agent 호출의 결과(tool_result)로만 오고 중간 텍스트는 SDK 가 넘겨주지 않습니다.
   대신 `agentProgressSummaries` 옵션을 켜서 `task_started`(지시문·유형) / `task_progress`(진행 요약, 마지막 도구,
   토큰·도구 수) / `task_notification`(완료 상태·최종 요약) 메시지를 Agent 호출 상세에 보여 줍니다.

firestore.rules      Firestore 보안 규칙 (users/{uid} 아래만 본인 읽기/쓰기)
.github/workflows/release.yml   태그 푸시 시 설치 파일 빌드 → GitHub Releases

## 다음 단계 아이디어

- 코드 서명 (인증서가 있어야 함; 없으면 설치 시 SmartScreen 경고가 뜸)
- 세션 기록 내보내기 (마크다운)
- 여러 작업 폴더 탭
