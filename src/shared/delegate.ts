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
/** 조율 역할이 아닌 직원이 한 작업에서 동료에게 문의할 수 있는 횟수. 넘으면 보고서로 상위에게 올린다 */
export const MAX_PEER_ROUNDS = 3
/** 인계로 같은 작업을 되돌려 보낼 수 있는 횟수 (개발 ↔ QA 가 끝없이 주고받지 않게). 넘으면 상위가 정리한다 */
export const MAX_HANDOFF_BACK = 3
/** 한 상위 작업 아래에 둘 수 있는 작업 수 (맡긴 것 + 인계로 생긴 것) */
export const MAX_TEAM_TASKS = 12
/** 팀 결정 기록에 남기는 건수 (넘으면 오래된 것부터 지운다) */
export const MAX_DECISIONS = 60

/** 작업을 맡긴 사람. ask 면 맡긴 것이 아니라 문의한 사람이다 */
export interface Lead {
  name: string
  role: string
  ask?: boolean
}

export interface Coordination {
  /** 새로 맡길 작업 */
  delegate: DispatchAssignment[]
  /** 보고받은 작업을 같은 직원에게 돌려보내기 (미흡한 점, 또는 그 직원의 질문에 대한 답) */
  revise: { task: string; instructions: string }[]
  /** 동료에게 문의: 답을 받으면 이 작업이 이어서 진행된다 */
  ask: { employee: string; question: string }[]
  /** 인계: 자기 일을 마치고 이어지는 일을 동료에게 넘긴다. 결과는 같은 상위가 받는다 */
  handoff: DispatchAssignment[]
  /** 다른 직원도 알아야 하는 결정 (팀 결정 기록에 남는다) */
  decisions: string[]
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

/**
 * 동료와 주고받는 방법 (문의·인계·결정 기록). 문의에 답하는 작업을 뺀 모든 직원에게 붙는다.
 * peers: 문의·인계할 수 있는 같은 팀 직원 목록. canHandoff: 상위가 있을 때만 인계할 수 있다.
 */
export function peerRules(o: { peers: string; canHandoff: boolean; leadName?: string }): string {
  const blocks = [
    '  "ask": [{"employee": "직원 이름 또는 직함", "question": "묻는 내용 (그 직원이 이것만 읽고 답할 수 있게)"}]',
    ...(o.canHandoff ? ['  "handoff": [{"employee": "직원 이름 또는 직함", "title": "작업 제목", "instructions": "넘기는 일: 무엇을, 왜, 완료 기준, 참고할 파일"}]'] : []),
    '  "decisions": ["다른 직원도 알아야 하는 결정 한 줄"]'
  ]
  return `

## 동료와 주고받기
같은 팀 직원과는 사용자를 거치지 않고 직접 주고받습니다. 필요할 때 마지막 메시지에서 "## 보고" 보다 앞에 아래 형식의 코드블록을 쓰세요 (필요한 것만).
\`\`\`json
{
${blocks.join(',\n')}
}
\`\`\`
${o.peers ? `### 문의·인계할 수 있는 직원\n${o.peers}\n` : ''}
- **문의(ask)**: 동료만 아는 것(그 사람이 만든 것의 인터페이스·형식·의도, 맞춰야 하는 이름이나 위치)이 필요할 때 씁니다. 답이 오면 당신의 작업이 그 자리에서 이어지니, 답과 무관한 부분은 먼저 해 두세요. 파일을 읽으면 알 수 있는 것은 묻지 말고 직접 확인합니다. 한 작업에서 ${MAX_PEER_ROUNDS}번까지입니다.
${
  o.canHandoff
    ? `- **인계(handoff)**: 당신의 일을 마친 뒤 다른 분야에서 이어서 해야 할 일을 그 직원에게 넘깁니다. 예: 구현을 마치고 검증을 QA 에게, 검증에서 찾은 결함을 만든 사람에게, 리뷰 지적을 작성자에게. 넘긴 일의 결과는 당신이 아니라 ${o.leadName ?? '상위'}이(가) 받습니다. 당신의 보고서에는 무엇을 누구에게 넘겼는지 적으세요. 같은 일을 주고받는 것은 ${MAX_HANDOFF_BACK}번까지이고, 그래도 안 풀리면 "상위 확인 요청"에 적습니다.\n`
    : ''
}- **결정(decisions)**: 작업하면서 정한 것 가운데 다른 직원도 따라야 하는 것(이름, 인터페이스, 파일 위치, 형식, 범위)을 한 줄씩 적으면 팀 결정 기록에 남아 모든 직원에게 전달됩니다. 이미 기록에 있는 것은 다시 적지 않습니다.
- "팀 결정 기록"에 있는 것은 이미 정해진 것입니다. 다시 묻지 말고 그대로 따르세요. 따를 수 없는 이유가 있으면 그 이유를 보고서에 적습니다.`
}

/** 동료의 문의에 답하는 작업의 규칙 */
export function askReportRules(asker: Lead): string {
  return `

## 답하는 방법
- 이것은 같은 팀 ${asker.name}(${asker.role})의 문의입니다. 답은 사용자가 아니라 ${asker.name}에게 가고, ${asker.name}은(는) 답을 받아 자기 작업을 이어 갑니다.
- 묻는 것에만 정확하고 짧게 답하세요. 필요하면 파일을 열어 확인하되, 파일을 고치거나 새 작업을 벌이지 않습니다.
- 마지막 메시지를 아래 형식으로 끝내세요.
## 보고
**답**: (묻는 것에 대한 답. 모르면 모른다고 쓰고 누가 알 만한지 적습니다)
**근거**: (확인한 파일과 위치. 없으면 "없음")`
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
  const out: Coordination = { delegate: [], revise: [], ask: [], handoff: [], decisions: [] }
  const assignment = (raw: unknown): DispatchAssignment | null => {
    const a = raw as { employee?: unknown; title?: unknown; instructions?: unknown }
    if (typeof a?.title !== 'string' || typeof a.instructions !== 'string' || !a.title.trim() || !a.instructions.trim()) return null
    return { employeeId: a.employee ? String(a.employee).trim() : undefined, title: a.title.trim(), instructions: a.instructions.trim() }
  }
  // 지시문 안에 코드블록이 들어 있어도 읽을 수 있게 중괄호 짝으로 찾는다. 블록을 둘로 나눠 써도 합친다
  for (const o of extractJsonObjects(text)) {
    if (Array.isArray(o.delegate)) {
      for (const raw of o.delegate) {
        const a = raw as { employee?: unknown; title?: unknown; instructions?: unknown }
        if (typeof a?.title !== 'string' || typeof a.instructions !== 'string' || !a.title.trim() || !a.instructions.trim()) continue
        out.delegate.push({ employeeId: a.employee ? String(a.employee).trim() : undefined, title: a.title.trim(), instructions: a.instructions.trim() })
      }
    }
    if (Array.isArray(o.handoff)) {
      for (const raw of o.handoff) {
        const a = assignment(raw)
        if (a) out.handoff.push(a)
      }
    }
    if (Array.isArray(o.ask)) {
      for (const raw of o.ask) {
        const q = raw as { employee?: unknown; question?: unknown }
        if (typeof q?.employee !== 'string' || typeof q.question !== 'string' || !q.employee.trim() || !q.question.trim()) continue
        out.ask.push({ employee: q.employee.trim(), question: q.question.trim() })
      }
    }
    if (Array.isArray(o.decisions)) {
      for (const d of o.decisions) if (typeof d === 'string' && d.trim()) out.decisions.push(d.trim().replace(/\s+/g, ' ').slice(0, 300))
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
  out.handoff = out.handoff.slice(0, 3)
  out.ask = out.ask.slice(0, 3)
  out.decisions = out.decisions.slice(0, 8)
  return out
}
