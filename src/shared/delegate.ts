// 조율 역할의 직원(PM 등)이 다른 직원에게 일을 맡기는 방법.
// 직원이 마지막 메시지에 delegate 블록을 쓰면 앱이 그 직원들에게 작업을 시작시키고, 모두 끝나면 보고를 모아 다시 전달한다.
import type { DispatchAssignment } from './types'
import { extractJsonObjects } from './json'

/** 한 번에 맡길 수 있는 작업 수 */
export const MAX_DELEGATE_TASKS = 5
/** 한 작업(또는 한 채팅 요청)에서 자동으로 이어 가는 횟수. 넘으면 사용자의 지시를 기다린다 */
export const MAX_AUTO_ROUNDS = 4

/** 조율 역할의 직원에게 붙는 지시. roster 는 같은 팀 직원 목록 */
export function delegateRules(roster: string): string {
  return `

## 다른 직원에게 일 맡기기
당신은 조율하는 역할이라 같은 팀의 다른 직원에게 일을 맡길 수 있습니다. 직접 하기에 맞지 않는 일(코드 구현, 검증, 문서화 등)은 혼자 문서로만 정리하고 끝내지 말고 맞는 직원에게 맡기세요.

### 같은 팀 직원
${roster || '(아직 다른 직원이 없습니다. 아래처럼 직함을 적으면 그 직함의 직원이 새로 채용됩니다: 프론트엔드 개발자, 백엔드 개발자, QA 엔지니어, 아키텍트, 기획자 (Planner), 테크니컬 라이터, 코드 리뷰어, 보안 엔지니어)'}

### 방법
마지막 메시지에서 "## 보고" 보다 앞에 아래 형식의 코드블록을 하나 쓰세요. 앱이 그 직원들에게 작업을 바로 시작시키고, 모두 끝나면 보고를 모아 당신에게 다시 전달합니다. 그때 결과를 검토하고 다음 단계를 이어 가면 됩니다.
\`\`\`json
{"delegate": [{"employee": "직원 이름 또는 직함", "title": "작업 제목 (20자 안팎)", "instructions": "그 직원이 이것만 읽고 바로 시작할 수 있는 지시: 무엇을, 왜, 완료 기준, 건드리면 안 되는 것, 참고할 파일"}]}
\`\`\`
- 한 번에 ${MAX_DELEGATE_TASKS}개까지. 맡긴 작업들은 동시에 실행되므로 서로의 결과에 의존하는 일은 한 작업으로 합치거나 다음 차례로 미루세요.
- 지금 할 수 있는 단계만 맡기세요. 그 결과가 필요한 다음 단계는 보고를 받은 뒤에 맡깁니다.
- 맡길 일이 없으면 블록을 쓰지 마세요. 보고서의 "한 일"에는 누구에게 무엇을 맡겼는지 적으세요.`
}

/** 마지막 메시지에서 delegate 블록을 꺼낸다. 없거나 형식이 틀리면 빈 배열 */
export function parseDelegation(text: string): DispatchAssignment[] {
  // delegate 키를 가진 마지막 JSON 객체 (지시문 안에 코드블록이 들어 있어도 읽을 수 있게 중괄호 짝으로 찾는다)
  const blocks = extractJsonObjects(text).filter((o) => 'delegate' in o)
  const list = blocks[blocks.length - 1]?.delegate
  if (!Array.isArray(list)) return []
  const out: DispatchAssignment[] = []
  for (const raw of list) {
    const a = raw as { employee?: unknown; title?: unknown; instructions?: unknown }
    if (typeof a?.title !== 'string' || typeof a.instructions !== 'string' || !a.title.trim() || !a.instructions.trim()) continue
    out.push({ employeeId: a.employee ? String(a.employee).trim() : undefined, title: a.title.trim(), instructions: a.instructions.trim() })
  }
  return out.slice(0, MAX_DELEGATE_TASKS)
}
