import { useState } from 'react'
import type { AppConfig, SavedSessionMeta } from '../../../shared/types'
import { authErrorText, ensureFirebase, parseFirebaseConfig, register, signIn, signOut, type FbUser } from '../firebase'

/** 세션 기록 저장 상태 (App 이 관리) */
export type SyncState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: number } | { kind: 'error'; message: string }

function fmtWhen(ms: number): string {
  const d = new Date(ms)
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  return sameDay
    ? d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
}

/** 사이드바 "세션 기록" */
export function SessionHistory(p: {
  enabled: boolean
  user: FbUser | null
  sessions: SavedSessionMeta[]
  currentId?: string
  hostname: string
  sync: SyncState
  running: boolean
  onOpen: (id: string) => void
  onDelete: (id: string) => void
  onOpenSettings: () => void
}) {
  if (!p.enabled) {
    return (
      <div className="muted small">
        Firebase 를 연결하면 대화 기록이 저장되고 다른 PC 에서도 볼 수 있습니다.{' '}
        <button className="link" onClick={p.onOpenSettings}>
          설정
        </button>
      </div>
    )
  }
  if (!p.user) {
    return (
      <div className="muted small">
        로그인하면 세션이 저장됩니다.{' '}
        <button className="link" onClick={p.onOpenSettings}>
          로그인
        </button>
      </div>
    )
  }
  return (
    <div className="history">
      <div className="history-status muted small">
        {p.sync.kind === 'saving' && '저장 중…'}
        {p.sync.kind === 'saved' && `저장됨 ${fmtWhen(p.sync.at)}`}
        {p.sync.kind === 'error' && <span className="danger" title={p.sync.message}>저장 실패</span>}
        {p.sync.kind === 'idle' && (p.sessions.length ? `${p.sessions.length}개` : '아직 저장된 세션 없음')}
      </div>
      <ul className="history-list">
        {p.sessions.map((s) => (
          <li
            key={s.id}
            className={s.id === p.currentId ? 'active' : ''}
            title={`${s.cwd}\n${s.host ? `PC: ${s.host}\n` : ''}${new Date(s.updatedAt).toLocaleString('ko-KR')}`}
          >
            <button className="history-main" disabled={p.running} onClick={() => p.onOpen(s.id)}>
              <span className="history-title">{s.title || '(제목 없음)'}</span>
              <span className="history-meta">
                {fmtWhen(s.updatedAt)} · {s.numTurns}턴
                {s.host && s.host !== p.hostname ? ' · 다른 PC' : ''}
              </span>
            </button>
            <button
              className="ghost history-del"
              title="기록 삭제"
              disabled={p.running}
              onClick={() => {
                if (confirm(`"${s.title}" 기록을 삭제할까요?`)) p.onDelete(s.id)
              }}
            >
              ✕
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 설정 창 "Firebase" 탭 */
export function FirebaseTab(p: {
  draft: AppConfig
  user: FbUser | null
  onChange: (c: AppConfig) => void
  setMsg: (s: string) => void
}) {
  const fb = p.draft.firebase
  const [cfgText, setCfgText] = useState(fb.config ? JSON.stringify(fb.config, null, 2) : '')
  const [cfgErr, setCfgErr] = useState('')
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (patch: Partial<AppConfig['firebase']>): void =>
    p.onChange({ ...p.draft, firebase: { ...fb, ...patch } })

  const applyConfigText = (text: string): void => {
    setCfgText(text)
    if (!text.trim()) {
      setCfgErr('')
      set({ config: undefined })
      return
    }
    try {
      const cfg = parseFirebaseConfig(text)
      setCfgErr('')
      set({ config: cfg, enabled: true })
    } catch (e) {
      setCfgErr(e instanceof Error ? e.message : String(e))
    }
  }

  const doAuth = async (mode: 'in' | 'up'): Promise<void> => {
    setBusy(true)
    try {
      const ok = await ensureFirebase(fb)
      if (!ok) throw new Error('firebaseConfig 를 먼저 붙여넣으세요.')
      const u = mode === 'in' ? await signIn(email.trim(), pw) : await register(email.trim(), pw)
      p.setMsg(`${u.email} 로 로그인했습니다. 설정을 저장하면 다음 턴부터 기록이 저장됩니다.`)
      setPw('')
    } catch (e) {
      p.setMsg(authErrorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="form">
      <div className="kv">
        <span>상태</span>
        <b>
          {!fb.config ? '미설정' : !fb.enabled ? '꺼짐' : p.user ? `연결됨 · ${p.user.email}` : '로그인 필요'}
        </b>
      </div>

      <label className="check">
        <input type="checkbox" checked={fb.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <div>
          <div className="mode-label">Firebase 사용</div>
          <div className="mode-desc">세션 기록을 Firestore 에 저장하고 사이드바 "세션 기록"에서 불러옵니다.</div>
        </div>
      </label>

      <h4>firebaseConfig</h4>
      <div className="muted small">
        Firebase 콘솔 → 프로젝트 설정 → 내 앱 → 웹 앱의 <code>firebaseConfig</code> 를 그대로 붙여넣으세요
        (<code>const firebaseConfig = {'{'} … {'}'}</code> 형태 그대로도 됩니다). 공개용 식별자라 비밀이 아닙니다.
      </div>
      <textarea
        className="text mono"
        rows={7}
        placeholder={'{\n  apiKey: "AIza…",\n  authDomain: "my-app.firebaseapp.com",\n  projectId: "my-app",\n  appId: "1:…:web:…"\n}'}
        value={cfgText}
        onChange={(e) => applyConfigText(e.target.value)}
      />
      {cfgErr && <div className="notice error">{cfgErr}</div>}
      {fb.config && (
        <div className="kv small">
          <span>프로젝트</span>
          <b className="mono">{fb.config.projectId}</b>
        </div>
      )}

      <h4>계정 (이메일 / 비밀번호)</h4>
      <div className="muted small">
        Firebase 콘솔 → Authentication → 로그인 방법에서 <b>이메일/비밀번호</b>를 켜 두어야 합니다.
      </div>
      {p.user ? (
        <div className="row">
          <span>
            <b>{p.user.email}</b> 로 로그인됨
          </span>
          <button
            onClick={async () => {
              await signOut()
              p.setMsg('로그아웃했습니다.')
            }}
          >
            로그아웃
          </button>
        </div>
      ) : (
        <div className="row">
          <input
            className="text"
            type="email"
            placeholder="email@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
          <input
            className="text"
            type="password"
            placeholder="비밀번호 (6자 이상)"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoComplete="off"
          />
          <button className="primary" disabled={busy || !email || !pw || !fb.config} onClick={() => doAuth('in')}>
            로그인
          </button>
          <button disabled={busy || !email || !pw || !fb.config} onClick={() => doAuth('up')}>
            계정 만들기
          </button>
        </div>
      )}

      <h4>저장</h4>
      <label className="check">
        <input
          type="checkbox"
          checked={fb.saveSessions}
          onChange={(e) => set({ saveSessions: e.target.checked })}
        />
        <div>
          <div className="mode-label">대화가 끝날 때마다 세션 저장</div>
          <div className="mode-desc">
            메시지, 도구 호출(결과는 6,000자까지), 사용량을 <code>users/{'{uid}'}/sessions/{'{세션ID}'}</code> 에
            저장합니다. 이어서 대화하기는 같은 PC 에서만 되고, 다른 PC 에서는 읽기 전용으로 열립니다.
          </div>
        </div>
      </label>

      <h4>Firestore 보안 규칙</h4>
      <div className="muted small">
        저장소의 <code>firestore.rules</code> 를 콘솔 → Firestore Database → 규칙에 붙여넣으세요. 로그인한
        사용자가 자기 문서만 읽고 쓸 수 있게 제한합니다.
      </div>

      <details>
        <summary className="muted small">개발용: 에뮬레이터</summary>
        <label className="field">
          <span>Auth,Firestore 에뮬레이터 호스트 (비우면 실제 Firebase)</span>
          <input
            className="text mono"
            placeholder="127.0.0.1:9099,127.0.0.1:8080"
            value={fb.emulator ?? ''}
            onChange={(e) => set({ emulator: e.target.value || undefined })}
          />
        </label>
      </details>
    </div>
  )
}
