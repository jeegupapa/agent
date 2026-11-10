import { useState } from 'react'
import { EFFORT_LEVELS, EMPLOYEE_PRESETS, type EffortLevel, type Employee, type PermissionMode, type TeamTask } from '../../../shared/types'
import { isTeamAware } from './status'

import { ModelSelect } from '../models'

const MODES: { value: PermissionMode; label: string; desc: string }[] = [
  { value: 'acceptEdits', label: '편집 자동 승인', desc: '파일 편집은 알아서, 명령 실행은 물어봄 (권장)' },
  { value: 'default', label: '매번 확인', desc: '편집·명령 모두 승인 요청이 올라옴' },
  { value: 'bypassPermissions', label: '모두 허용', desc: '확인 없이 전부 실행 (주의)' },
  { value: 'plan', label: '계획만', desc: '실행하지 않고 계획만 세움' }
]

const COLORS = ['#5b8def', '#4caf7d', '#e3b341', '#c678dd', '#e5534b', '#2bb3c0', '#d97757', '#8b93a5']
const EMOJIS = ['🎨', '🛠️', '🔍', '📝', '🧐', '🧪', '📊', '🤖', '🧭', '🧩', '📐', '🔐', '🚀']

export function EmployeeForm(p: {
  initial?: Employee
  onSave: (e: Employee) => void
  onCancel: () => void
  /** 편집 중인 직원 삭제 (새 직원 폼에는 없음) */
  onDelete?: () => void
}) {
  const now = Date.now()
  const [draft, setDraft] = useState<Employee>(
    p.initial ?? {
      id: crypto.randomUUID(),
      name: '',
      role: '',
      emoji: '🤖',
      color: COLORS[0],
      specialty: '',
      instructions: '',
      permissionMode: 'acceptEdits',
      createdAt: now,
      updatedAt: now
    }
  )
  const set = (patch: Partial<Employee>): void => setDraft((d) => ({ ...d, ...patch }))
  const valid = draft.name.trim() && draft.role.trim() && draft.instructions.trim()

  return (
    <div className="modal-backdrop" onClick={p.onCancel}>
      <div className="modal settings team-form" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h3>{p.initial ? '직원 편집' : '새 직원'}</h3>
          <button className="ghost" onClick={p.onCancel}>
            ✕
          </button>
        </div>
        <div className="settings-body form">
          {!p.initial && (
            <>
              <h4>템플릿으로 시작</h4>
              <div className="preset-grid">
                {EMPLOYEE_PRESETS.map((pr) => (
                  <button
                    key={pr.role}
                    className="preset-card"
                    style={{ borderColor: pr.color }}
                    onClick={() => set({ ...pr, id: draft.id, createdAt: draft.createdAt, updatedAt: now })}
                  >
                    <span className="preset-emoji">{pr.emoji}</span>
                    <b>{pr.role}</b>
                    <span className="muted small">{pr.specialty}</span>
                  </button>
                ))}
              </div>
            </>
          )}

          <h4>기본 정보</h4>
          <div className="row">
            <label className="field" style={{ flex: 0, minWidth: 90 }}>
              <span>아바타</span>
              <select className="text" value={draft.emoji} onChange={(e) => set({ emoji: e.target.value })}>
                {EMOJIS.concat(EMOJIS.includes(draft.emoji) ? [] : [draft.emoji]).map((em) => (
                  <option key={em} value={em}>
                    {em}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>이름</span>
              <input className="text" value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="예: 민준" />
            </label>
            <label className="field">
              <span>직함</span>
              <input className="text" value={draft.role} onChange={(e) => set({ role: e.target.value })} placeholder="예: 프론트엔드 개발자" />
            </label>
          </div>
          <label className="field">
            <span>전문 분야 (한 줄)</span>
            <input className="text" value={draft.specialty} onChange={(e) => set({ specialty: e.target.value })} />
          </label>
          <div className="row">
            <span className="muted small">색상</span>
            {COLORS.map((c) => (
              <button
                key={c}
                className={`swatch ${draft.color === c ? 'active' : ''}`}
                style={{ background: c }}
                onClick={() => set({ color: c })}
                title={c}
              />
            ))}
          </div>

          <h4>지시문</h4>
          <div className="muted small">
            Claude Code 기본 능력은 그대로 두고 그 위에 붙는 역할 지시입니다. 작업 방식, 금지 사항, 품질 기준을 적으세요.
            작업이 끝나면 "## 보고" 형식으로 보고하라는 규칙은 자동으로 추가됩니다.
          </div>
          <textarea
            className="text"
            rows={Math.min(24, Math.max(7, draft.instructions.split('\n').length + 1))}
            value={draft.instructions}
            onChange={(e) => set({ instructions: e.target.value })}
            placeholder="당신은 … 입니다. 작업 전에 … 를 확인하고, … 는 하지 마세요."
          />

          <h4>실행 설정</h4>
          <div className="row">
            <label className="field">
              <span>이 직원이 쓸 모델</span>
              <ModelSelect value={draft.model} emptyLabel="기본 모델 (사이드바 설정값)" emptyFirst onChange={(model) => set({ model })} />
            </label>
            <label className="field">
              <span>노력 (생각의 깊이)</span>
              <select className="text" value={draft.effort ?? ''} onChange={(e) => set({ effort: (e.target.value || undefined) as EffortLevel | undefined })}>
                <option value="">사이드바 설정값</option>
                {EFFORT_LEVELS.map((l) => (
                  <option key={l.value} value={l.value}>
                    {l.label} ({l.value})
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>기본 작업 폴더 (비우면 작업마다 지정)</span>
              <div className="row">
                <input
                  className="text mono"
                  value={draft.defaultCwd ?? ''}
                  onChange={(e) => set({ defaultCwd: e.target.value || undefined })}
                  placeholder="C:\\projects\\my-app"
                />
                <button
                  onClick={async () => {
                    const f = await window.api.pickFolder()
                    if (f) set({ defaultCwd: f })
                  }}
                >
                  선택…
                </button>
              </div>
            </label>
          </div>
          <div className="modes">
            {MODES.map((m) => (
              <label key={m.value} className={draft.permissionMode === m.value ? 'mode active' : 'mode'}>
                <input
                  type="radio"
                  checked={draft.permissionMode === m.value}
                  onChange={() => set({ permissionMode: m.value })}
                />
                <div>
                  <div className="mode-label">{m.label}</div>
                  <div className="mode-desc">{m.desc}</div>
                </div>
              </label>
            ))}
          </div>
          <label className="check" title="PM 처럼 다른 직원의 일을 조율하는 역할에 켭니다. 작업을 시작할 때 누가 무엇을 하고 있는지, 최근에 무엇이 끝났는지가 지시와 함께 전달됩니다">
            <input type="checkbox" checked={isTeamAware(draft)} onChange={(e) => set({ teamAware: e.target.checked })} />
            <span>작업을 시작할 때 팀 전체의 작업 현황을 함께 알려 주기</span>
          </label>
        </div>
        <div className="modal-actions settings-foot">
          <span className="row">
            {p.initial && p.onDelete && (
              <button
                className="danger"
                onClick={() => {
                  if (confirm(`${draft.name}(${draft.role}) 직원을 삭제할까요? 작업 기록은 남습니다.`)) p.onDelete!()
                }}
              >
                직원 삭제
              </button>
            )}
            <span className="muted small">{valid ? '' : '이름, 직함, 지시문은 필수입니다.'}</span>
          </span>
          <span className="row">
            <button onClick={p.onCancel}>취소</button>
            <button className="primary" disabled={!valid} onClick={() => p.onSave({ ...draft, updatedAt: Date.now() })}>
              저장
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}

export function TaskForm(p: {
  employees: Employee[]
  defaultEmployeeId?: string
  defaultCwd: string
  onSubmit: (task: TeamTask) => void
  onCancel: () => void
}) {
  const [employeeId, setEmployeeId] = useState(p.defaultEmployeeId ?? p.employees[0]?.id ?? '')
  const emp = p.employees.find((e) => e.id === employeeId)
  const [title, setTitle] = useState('')
  const [instructions, setInstructions] = useState('')
  const [cwd, setCwd] = useState(emp?.defaultCwd ?? p.defaultCwd)
  const valid = employeeId && title.trim() && instructions.trim() && cwd.trim()

  return (
    <div className="modal-backdrop" onClick={p.onCancel}>
      <div className="modal settings team-form" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h3>작업 지시</h3>
          <button className="ghost" onClick={p.onCancel}>
            ✕
          </button>
        </div>
        <div className="settings-body form">
          <label className="field">
            <span>담당 직원</span>
            <div className="emp-pick">
              {p.employees.map((e) => (
                <button
                  key={e.id}
                  className={`emp-chip ${e.id === employeeId ? 'active' : ''}`}
                  style={{ borderColor: e.id === employeeId ? e.color : undefined }}
                  onClick={() => {
                    setEmployeeId(e.id)
                    if (e.defaultCwd) setCwd(e.defaultCwd)
                  }}
                >
                  <span>{e.emoji}</span> {e.name} <span className="muted">· {e.role}</span>
                </button>
              ))}
            </div>
          </label>
          <label className="field">
            <span>작업 제목</span>
            <input className="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 로그인 화면 에러 메시지 개선" autoFocus />
          </label>
          <label className="field">
            <span>지시 내용 (무엇을, 왜, 완료 기준)</span>
            <textarea
              className="text"
              rows={8}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder={'1. …\n2. …\n완료 기준: …'}
            />
          </label>
          <label className="field">
            <span>작업 폴더</span>
            <div className="row">
              <input className="text mono" value={cwd} onChange={(e) => setCwd(e.target.value)} />
              <button
                onClick={async () => {
                  const f = await window.api.pickFolder()
                  if (f) setCwd(f)
                }}
              >
                선택…
              </button>
            </div>
          </label>
          {emp && (
            <div className="muted small">
              {emp.emoji} {emp.name} 은(는) <b>{MODES.find((m) => m.value === emp.permissionMode)?.label}</b> 모드로 실행되고,
              끝나면 보고서가 "검토 요청" 상태로 올라옵니다.
            </div>
          )}
        </div>
        <div className="modal-actions settings-foot">
          <span />
          <span className="row">
            <button onClick={p.onCancel}>취소</button>
            <button
              className="primary"
              disabled={!valid}
              onClick={() =>
                p.onSubmit({
                  id: crypto.randomUUID(),
                  employeeId,
                  title: title.trim(),
                  instructions: instructions.trim(),
                  cwd: cwd.trim(),
                  status: 'queued',
                  createdAt: Date.now(),
                  progress: { toolUses: 0 },
                  reviews: [],
                  round: 0
                })
              }
            >
              지시하고 시작
            </button>
          </span>
        </div>
      </div>
    </div>
  )
}
