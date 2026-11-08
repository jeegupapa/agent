import { useState, type ReactElement } from 'react'
import type { MemoryItem } from '../../../shared/types'
import { MemoryDialog } from './MemoryDialog'
import { normPath, type MemoryStore } from './store'

/** 설정 → 메모리: 저장된 메모리 목록 (이 폴더 / 모든 폴더 / 다른 폴더), 켜기·끄기, 수정, 삭제 */
export function MemoryTab(p: { store: MemoryStore; cwd: string }) {
  const [editing, setEditing] = useState<(Partial<MemoryItem> & { text: string }) | null>(null)
  const [showOther, setShowOther] = useState(false)
  const here = normPath(p.cwd)
  const list = p.store.memories
  const hereList = list.filter((m) => m.scope === 'project' && m.cwd && normPath(m.cwd) === here)
  const globalList = list.filter((m) => m.scope === 'global')
  const otherList = list.filter((m) => m.scope === 'project' && !(m.cwd && normPath(m.cwd) === here))
  const activeCount = list.filter((m) => m.enabled && (m.scope === 'global' || (m.cwd && normPath(m.cwd) === here))).length

  const row = (m: MemoryItem): ReactElement => (
    <li key={m.id} className={`memory-row ${m.enabled ? '' : 'off'}`}>
      <input
        type="checkbox"
        checked={m.enabled}
        title={m.enabled ? '끄면 프롬프트에 넣지 않습니다' : '켜면 다음 세션부터 적용'}
        onChange={(e) => p.store.upsert({ ...m, enabled: e.target.checked, updatedAt: Date.now() })}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="memory-text">{m.text}</div>
        <div className="memory-meta">
          <span className="kind-badge">{m.scope === 'global' ? '모든 폴더' : '이 폴더'}</span>
          {m.scope === 'project' && m.cwd && <span className="mono" title={m.cwd}>{m.cwd.length > 40 ? '…' + m.cwd.slice(-40) : m.cwd}</span>}
          <span>{new Date(m.createdAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          {m.source?.kind === 'command' && <span>채팅 "기억해"</span>}
          {m.source?.kind === 'chat' && <span>채팅 메시지{m.source.sessionTitle ? ` · ${m.source.sessionTitle}` : ''}</span>}
        </div>
      </div>
      <span className="row" style={{ flexWrap: 'nowrap' }}>
        <button className="small-btn" onClick={() => setEditing(m)}>
          수정
        </button>
        <button
          className="small-btn danger"
          onClick={() => {
            if (confirm('이 메모리를 삭제할까요?')) p.store.remove(m.id)
          }}
        >
          삭제
        </button>
      </span>
    </li>
  )

  return (
    <div className="form">
      <div className="kv">
        <span>
          저장 위치: {p.store.backend === 'firestore' ? 'Firebase (로그인 계정)' : '이 PC (Firebase 로그인 시 동기화)'}
          {p.store.error ? ` · 오류: ${p.store.error}` : ''}
        </span>
        <b>
          이 폴더에 적용 중 {activeCount}개 / 전체 {list.length}개
        </b>
      </div>
      <div className="muted small">
        메모리는 세션을 시작할 때 Claude 와 직원들의 시스템 프롬프트에 "# 사용자 메모리" 로 붙습니다. 채팅에서{' '}
        <b>기억해: …</b> 라고 보내거나, 메시지 옆의 💾 버튼으로도 저장할 수 있습니다. 이미 진행 중인 세션에는 새 세션부터 적용됩니다.
      </div>
      <div className="row">
        <button className="primary" onClick={() => setEditing({ text: '', scope: 'project', cwd: p.cwd })}>
          + 새 메모리
        </button>
      </div>

      <h4>이 폴더 ({hereList.length})</h4>
      {hereList.length === 0 && <div className="muted small">{p.cwd} 에만 적용되는 메모리가 없습니다.</div>}
      <ul className="memory-list">{hereList.map(row)}</ul>

      <h4>모든 폴더 ({globalList.length})</h4>
      {globalList.length === 0 && <div className="muted small">어느 폴더에서나 적용되는 메모리가 없습니다.</div>}
      <ul className="memory-list">{globalList.map(row)}</ul>

      {otherList.length > 0 && (
        <>
          <h4>
            다른 폴더 ({otherList.length}){' '}
            <button className="ghost small-btn" onClick={() => setShowOther((v) => !v)}>
              {showOther ? '접기' : '펼치기'}
            </button>
          </h4>
          {showOther && <ul className="memory-list">{otherList.map(row)}</ul>}
        </>
      )}

      {editing && (
        <MemoryDialog
          initial={editing}
          cwd={p.cwd}
          onSave={(m) => {
            p.store.upsert(m)
            setEditing(null)
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  )
}
