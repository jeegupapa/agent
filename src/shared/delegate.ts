// 팀의 조율 규칙.
//
// 구조: 사용자 ↔ PM ↔ 기획자 ↔ 분야별 전문가.
// - 조율 역할의 직원(PM, 기획자)은 같은 팀 직원에게 일을 맡기고(delegate), 보고받은 작업을 돌려보낼 수 있다(revise).
// - 맡긴 작업이 끝나면 보고와 질문은 사용자가 아니라 맡긴 사람에게 간다. 맡긴 사람이 검토하고, 질문에 답하고,
//   자기도 정할 수 없는 것만 한 단계 위로 올린다. 사용자에게 오는 것은 맨 위(PM) 작업의 보고뿐이다.
import type { DispatchAssignment } from './types'
import { extractJsonObjects } from './json'

/** 한 번에 맡길 수 있는 작업 수 */
export const MAX_DELEGATE_TASKS = 5
/** 한 작업이 "맡기기 → 보고 받기"를 되풀이할 수 있는 횟수. 넘으면 지금까지의 결과로 마무리한다 */
export const MAX_AUTO_ROUNDS = 6
/** 맡기기 깊이: PM(0) → 기획자(1) → 전문가(2). 깊이 2 의 직원은 더 맡기지 못한다 */
export const MAX_DEPTH = 2

/** 작업을 맡긴 사람 */
export interface Lead {
  name: string
  role: string
}

export interface Coordination {
  /** 새로 맡길 작업 */
  delegate: DispatchAssignment[]
  /** 보고받은 작업을 같은 직원에게 돌려보내기 (미흡한 점, 또는 그 직원의 질문에 대한 답) */
  revise: { task: string; instructions: string }[]
}

const USER_ONLY = '비용이 드는 일, 데이터 삭제, 외부 공개, 라이선스·법적 판단, 프로그램 설치, 요청 범위를 바꾸는 일'

/**
 * 조율 역할의 직원에게 붙는 지시.
 * frontDoor: 사용자에게 직접 받은 일이다 (팀의 창구). 아니면 상위 직원에게 받은 일이다.
 */
export function coordinatorRules(o: { roster: string; frontDoor: boolean }): string {
  return `

## 팀을 이끄는 방법
당신은 이 팀의 조율자입니다. ${
    o.frontDoor
      ? '사용자와 팀 사이의 유일한 창구이기도 합니다. 사용자의 요청은 당신이 받고, 팀의 결과와 질문도 당신이 걸러서 사용자에게 전합니다.'
      : '상위에게 받은 일을 나눠 전문가에게 맡기고, 결과를 모아 상위에게 보고합니다.'
  }
- 직접 하기에 맞지 않는 일(코드 구현, 검증, 문서화 등)은 혼자 문서로만 정리하고 끝내지 말고 맞는 직원에게 맡기세요. 단순한 질문이나 현황 보고처럼 맡길 일이 없으면 바로 답하면 됩니다.
${
  o.frontDoor
    ? '- 일이 크거나 여러 분야에 걸치면 기획자에게 계획·작업 분해와 전문가 배분까지 맡기고, 작고 분명한 일은 전문가에게 바로 맡기세요.\n'
    : ''
}- 맡긴 작업이 끝나면 보고는 사용자에게 가지 않고 당신에게 옵니다. 그때 결과를 검토하고, 직원의 질문에는 당신이 답합니다.

### 같은 팀 직원
${o.roster || '(아직 다른 직원이 없습니다. 아래처럼 직함을 적으면 그 직함의 직원이 새로 채용됩니다: 기획자 (Planner), 프론트엔드 개발자, 백엔드 개발자, QA 엔지니어, 아키텍트, 테크니컬 라이터, 코드 리뷰어, 보안 엔지니어)'}

### 맡기기와 돌려보내기
마지막 메시지에서 "## 보고" 보다 앞에 아래 형식의 코드블록을 하나 쓰세요. 필요한 쪽만 쓰면 됩니다.
\`\`\`json
{
  "delegate": [{"employee": "직원 이름 또는 직함", "title": "작업 제목 (20자 안팎)", "instructions": "그 직원이 이것만 읽고 바로 시작할 수 있는 지시: 무엇을, 왜, 완료 기준, 건드리면 안 되는 것, 참고할 파일, 이미 정해진 사항"}],
  "revise": [{"task": "돌려보낼 작업의 제목", "instructions": "무엇이 부족한지와 고칠 내용, 또는 그 직원의 질문에 대한 답"}]
}
\`\`\`
- delegate 는 새 작업을 맡깁니다. 한 번에 ${MAX_DELEGATE_TASKS}개까지이고 동시에 실행되므로, 서로의 결과에 의존하는 일은 한 작업으로 합치거나 다음 차례로 미루세요. 지금 할 수 있는 단계만 맡깁니다.
- revise 는 이미 보고받은 작업을 같은 직원에게 돌려보냅니다. 결과가 지시나 완료 기준에 못 미칠 때, 또는 직원의 질문에 답해 이어서 하게 할 때 씁니다.
- 블록을 쓰면 그 작업들이 끝난 뒤 보고가 다시 당신에게 옵니다. 이때의 보고서에는 누구에게 무엇을 맡겼는지만 짧게 적으세요.
- 블록을 쓰지 않으면 당신의 일이 끝난 것으로 보고, 보고받은 작업들은 당신이 승인한 것으로 처리됩니다. 그러니 미흡한 작업을 그냥 두고 끝내지 마세요.

### 질문 거르기
- 직원이 올린 질문 가운데 당신이 정할 수 있는 것(범위, 우선순위, 순서, 이름, 무난한 기본값, 다른 직원의 산출물과 맞추는 일)은 당신이 정합니다. 문서나 이전 결정에 답이 있으면 그것으로 답하세요. 같은 질문이 사용자에게 다시 올라가지 않게 하는 것이 당신의 일입니다.
${
  o.frontDoor
    ? `- 사용자에게는 사용자만 정할 수 있는 것(${USER_ONLY})만 올리세요. 여러 직원의 질문을 하나로 모아 중복 없이, 가장 중요한 것부터 3개까지 보고서의 "확인 요청"에 적습니다. 답이 없어도 추천안으로 할 수 있는 일은 계속 진행시키세요.`
    : '- 당신도 정할 수 없는 것만 당신의 보고서 "상위 확인 요청"에 모아 올리세요. 사용자만 정할 수 있는 것은 "사용자 결정 필요"에 적습니다.'
}`
}

/** 상위 직원에게 일을 받은 직원의 보고 규칙 (보고와 질문이 사용자가 아니라 맡긴 사람에게 간다) */
export function leadReportRules(lead: Lead): string {
  const who = `${lead.name}(${lead.role})`
  return `

## 보고 규칙
- 이 작업은 ${who}이(가) 맡겼습니다. 보고는 사용자가 아니라 ${lead.name}에게 가고, ${lead.name}이(가) 검토합니다.
- 작업을 마치면 마지막 메시지를 반드시 아래 형식의 보고서로 끝내세요.
## 보고
**한 일**: (3줄 이내 요약)
**변경한 파일**: (경로 목록, 없으면 "없음")
**검증**: (실행한 테스트·빌드와 결과)
**상위 확인 요청**: (${lead.name}이(가) 정해 주면 되는 것. 없으면 "없음". 한 건에 한 줄, 선택지와 추천안 포함)
**사용자 결정 필요**: (사용자만 정할 수 있는 것: ${USER_ONLY}. 없으면 "없음")
- ${lead.name}은(는) 보고서만 읽고 판단하므로, 보고서는 그 자체로 이해되게 쓰세요.

## 스스로 정하고 끝까지 진행하기
- 질문 때문에 작업을 멈추지 마세요. 스스로 정할 수 있는 것은 정하고 맡은 일을 끝까지 하세요. 나중에 쉽게 바꿀 수 있는 선택(이름, 파일 위치, 세부 방식, 순서)은 가장 무난한 안으로 정해 진행하고, 무엇을 그렇게 정했는지만 "한 일"에 한 줄로 남깁니다.
- 확인 요청은 두 칸을 합쳐 3개까지만, 답이 없으면 정말로 다음 일을 할 수 없는 것만 적으세요. 다른 직원의 산출물과 맞춰야 하는 것, 범위나 우선순위처럼 팀 안에서 정할 수 있는 것은 "상위 확인 요청"입니다. "사용자 결정 필요"에는 위에 적힌 종류만 넣습니다.
- 확인 요청을 남기더라도 추천안을 기준으로 할 수 있는 데까지는 진행해 두세요.
- 실행해 달라는 지시에 계획·조사 문서만 내고 끝내지 마세요. 당신의 역할이 구현이면 실제로 구현하고 돌려 본 결과를 보고합니다.
- "검토 의견"을 받으면 그것을 반영해 이어서 진행하고 같은 형식으로 다시 보고하세요.`
}

/** 마지막 메시지에서 맡기기·돌려보내기 블록을 꺼낸다. 없거나 형식이 틀리면 둘 다 빈 배열 */
export function parseCoordination(text: string): Coordination {
  const out: Coordination = { delegate: [], revise: [] }
  // 지시문 안에 코드블록이 들어 있어도 읽을 수 있게 중괄호 짝으로 찾는다. 블록을 둘로 나눠 써도 합친다
  for (const o of extractJsonObjects(text)) {
    if (Array.isArray(o.delegate)) {
      for (const raw of o.delegate) {
        const a = raw as { employee?: unknown; title?: unknown; instructions?: unknown }
        if (typeof a?.title !== 'string' || typeof a.instructions !== 'string' || !a.title.trim() || !a.instructions.trim()) continue
        out.delegate.push({ employeeId: a.employee ? String(a.employee).trim() : undefined, title: a.title.trim(), instructions: a.instructions.trim() })
      }
    }
    if (Array.isArray(o.revise)) {
      for (const raw of o.revise) {
        const r = raw as { task?: unknown; instructions?: unknown }
        if (typeof r?.task !== 'string' || typeof r.instructions !== 'string' || !r.task.trim() || !r.instructions.trim()) continue
        out.revise.push({ task: r.task.trim(), instructions: r.instructions.trim() })
      }
    }
  }
  out.delegate = out.delegate.slice(0, MAX_DELEGATE_TASKS)
  return out
}
