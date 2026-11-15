// 모델의 답변 글에서 JSON 객체를 꺼낸다.
// 코드블록(```)을 기준으로 자르면, JSON 문자열 값 안에 코드블록이 들어 있을 때(지시문에 명령 예시를 넣는 경우) 중간에서 잘린다.
// 그래서 여는 중괄호마다 문자열과 이스케이프를 따져 짝이 맞는 닫는 중괄호를 찾고, 그 구간이 JSON 으로 읽히는지 본다.

/** start 위치의 '{' 와 짝이 맞는 '}' 의 위치. 없으면 -1 */
function matchBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let k = start; k < text.length; k++) {
    const c = text[k]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
    } else if (c === '"') inString = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return k
  }
  return -1
}

/** 글 안에 있는 최상위 JSON 객체를 나온 순서대로 돌려준다 (읽히지 않는 구간은 건너뛴다) */
export function extractJsonObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  let i = 0
  while (i < text.length) {
    const s = text.indexOf('{', i)
    if (s < 0) break
    const e = matchBrace(text, s)
    if (e > s) {
      try {
        const v: unknown = JSON.parse(text.slice(s, e + 1))
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          out.push(v as Record<string, unknown>)
          i = e + 1
          continue
        }
      } catch {
        /* JSON 이 아닌 중괄호 구간 */
      }
    }
    i = s + 1
  }
  return out
}
