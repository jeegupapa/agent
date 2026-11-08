import { useState } from 'react'
import type { MemoryItem } from '../../../shared/types'

/** 메모리 하나를 만들거나 고치는 작은 모달 */
export function MemoryDialog(p: {
  initial: Partial<MemoryItem> & { text: string }
  cwd: string
  onSave: (m: MemoryItem) => void
  onCancel: () => void
}) {
  const [text, setText] = useState(p.initial.text)
  const [scope, setScope] = useState<MemoryItem['scope']>(p.initial.scope ?? 'project')
  const valid = text.trim().length >= 2
  const save = (): void => {
    if (!valid) return
    const now = Date.now()
    p.onSave({
      id: p.initial.id ?? crypto.randomUUID(),
      text: text.trim(),
      scope,
      cwd: scope === 'project' ? p.initial.cwd ?? p.cwd : undefined,
      enabled: p.initial.enabled ?? true,
      source: p.initial.source ?? { kind: 'manual' },
      createdAt: p.initial.createdAt ?? now,
      updatedAt: now
    })
  }
  return (
    <div className="modal-backdrop" onClick={p.onCancel} style={{ zIndex: 40 }}>
      <div className="modal memory-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{p.initial.id ? '메모리 수정' : '메모리로 저장'}</h3>
        <p className="muted small">
          저장한 내용은 다음 세션부터 Claude 와 직원들의 시스템 프롬프트에 붙습니다. 규칙, 선호, 프로젝트 배경처럼 매번 알려 주기
          번거로운 것을 짧게 적으세요.
        </p>
        <textarea
          className="text"
          rows={Math.min(14, Math.max(5, text.split('\n').length + 1))}
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save()
            if (e.key === 'Escape') p.onCancel()
          }}
        />
        <div className="row">
          <label className={`mode ${scope === 'project' ? 'active' : ''}`} style={{ flex: 1 }}>
            <input type="radio" checked={scope === 'project'} onChange={() => setScope('project')} />
            <div>
              <div className="mode-label">이 폴더에서만</div>
              <div className="mode-desc mono small">{p.initial.cwd ?? p.cwd}</div>
            </div>
          </label>
          <label className={`mode ${scope === 'global' ? 'active' : ''}`} style={{ flex: 1 }}>
            <input type="radio" checked={scope === 'global'} onChange={() => setScope('global')} />
            <div>
              <div className="mode-label">모든 폴더에서</div>
              <div className="mode-desc">어느 프로젝트에서든 적용</div>
            </div>
          </label>
        </div>
        <div className="modal-actions">
          <span className="muted small" style={{ flex: 1 }}>
            Ctrl+Enter 저장
          </span>
          <button onClick={p.onCancel}>취소</button>
          <button className="primary" disabled={!valid} onClick={save}>
            저장
          </button>
        </div>
      </div>
    </div>
  )
}
