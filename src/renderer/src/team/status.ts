// 팀 작업 현황을 글로 정리한다. 팀장(배분)과 조율 역할의 직원(PM 등)에게 프롬프트로 전달해,
// 지금 누가 무엇을 하고 있고 무엇이 끝났는지 알고 답하거나 배분하게 한다.
import type { Employee, TeamTask } from '../../../shared/types'
import { STATUS_LABEL, isActive } from './runtime'

/** 작업을 시작할 때 팀 현황을 함께 받을 직원인지. 따로 정하지 않았으면 직함으로 판단한다 (PM, 매니저, 팀장) */
export function isTeamAware(e: Pick<Employee, 'role' | 'teamAware'>): boolean {
  return e.teamAware ?? /PM|매니저|팀장|manager/i.test(e.role)
}

function ago(ms: number | undefined, now: number): string {
  if (!ms) return ''
  const min = Math.max(0, Math.round((now - ms) / 60000))
  if (min < 1) return '방금'
  if (min < 60) return `${min}분 전`
  const h = Math.floor(min / 60)
  return h < 24 ? `${h}시간 ${min % 60}분 전` : `${Math.floor(h / 24)}일 전`
}

function oneLine(text: string | undefined, max: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

/** 보고서에서 "## 보고" 제목을 뺀 앞부분 */
function reportHead(report: string | undefined, max: number): string {
  return oneLine((report ?? '').replace(/^#+\s*보고\s*/m, ''), max)
}

/**
 * 진행 중인 작업 전부와, 끝난 작업 중 최근 것 몇 개를 적는다. exceptTaskId 는 지금 시작하는 작업 자신(목록에서 뺀다).
 * 작업이 하나도 없으면 빈 문자열.
 */
export function renderTeamStatus(employees: Employee[], tasks: TeamTask[], now = Date.now(), exceptTaskId?: string): string {
  const name = (id: string): string => {
    const e = employees.find((x) => x.id === id)
    return e ? `${e.name}(${e.role})` : '삭제된 직원'
  }
  const list = tasks.filter((t) => t.id !== exceptTaskId)
  const active = list.filter((t) => isActive(t.status))
  const waiting = list.filter((t) => t.status === 'needs_review')
  const recent = list
    .filter((t) => !isActive(t.status) && t.status !== 'needs_review' && t.status !== 'queued')
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))
    .slice(0, 8)
  if (active.length + waiting.length + recent.length === 0) return ''

  const lines: string[] = [`# 팀 작업 현황 (${new Date(now).toLocaleString('ko-KR')} 기준)`]
  const idle = employees.filter((e) => !active.some((t) => t.employeeId === e.id))
  lines.push(`직원 ${employees.length}명 · 진행 중 ${active.length}건 · 검토 대기 ${waiting.length}건` + (idle.length ? ` · 지금 작업이 없는 직원: ${idle.map((e) => e.name).join(', ')}` : ''))

  if (active.length) {
    lines.push('', '## 진행 중')
    for (const t of active) {
      const p = t.progress
      const bits = [
        `시작 ${ago(t.startedAt, now)}`,
        `도구 ${p.toolUses}회`,
        p.lastTool ? `지금 ${p.lastTool}` : '',
        t.status === 'waiting_permission' ? '사용자의 권한 승인을 기다리는 중' : '',
        t.status === 'changes_requested' ? `${t.round}차 수정 반영 중` : ''
      ].filter(Boolean)
      lines.push(`- [${STATUS_LABEL[t.status]}] ${name(t.employeeId)} — "${t.title}" (${bits.join(', ')})`)
      if (p.lastText) lines.push(`  최근 발언: ${oneLine(p.lastText, 200)}`)
    }
  }
  if (waiting.length) {
    lines.push('', '## 끝나서 사용자의 검토를 기다리는 작업')
    for (const t of waiting) {
      lines.push(`- ${name(t.employeeId)} — "${t.title}" (끝남 ${ago(t.finishedAt, now)})`)
      if (t.report) lines.push(`  보고 요약: ${reportHead(t.report, 300)}`)
    }
  }
  if (recent.length) {
    lines.push('', '## 최근에 끝난 작업')
    for (const t of recent) {
      lines.push(`- [${STATUS_LABEL[t.status]}] ${name(t.employeeId)} — "${t.title}" (${ago(t.finishedAt ?? t.createdAt, now)})`)
      if (t.status === 'failed' && t.error) lines.push(`  오류: ${oneLine(t.error, 160)}`)
      else if (t.report) lines.push(`  보고 요약: ${reportHead(t.report, 200)}`)
    }
  }
  return lines.join('\n')
}
