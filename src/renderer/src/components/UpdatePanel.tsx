import { useEffect, useState } from 'react'
import type { AppConfig, UpdateStatus } from '../../../shared/types'

export function fmtBytes(n?: number): string {
  if (!n) return '0 MB'
  return (n / 1_048_576).toFixed(1) + ' MB'
}

/** 상태 → 한 줄 설명 */
export function updateSummary(s: UpdateStatus | null): string {
  if (!s) return ''
  switch (s.state) {
    case 'disabled':
      return '배포 주소가 설정되지 않아 업데이트 확인이 꺼져 있습니다.'
    case 'idle':
      return '아직 확인하지 않았습니다.'
    case 'checking':
      return '업데이트 확인 중…'
    case 'available':
      return `새 버전 v${s.version} 이 있습니다.`
    case 'not-available':
      return `최신 버전입니다 (v${s.currentVersion}).`
    case 'downloading':
      return `v${s.version} 내려받는 중 ${Math.round(s.percent ?? 0)}%`
    case 'downloaded':
      return `v${s.version} 다운로드 완료. 재시작하면 설치됩니다.`
    case 'error':
      return `오류: ${s.error ?? '알 수 없음'}`
  }
}

/** 사이드바 상단 배너: 새 버전이 있거나 받는 중이거나 설치 대기일 때만 보인다 */
export function UpdateBanner(p: { status: UpdateStatus | null; running: boolean; onOpen: () => void }) {
  const s = p.status
  if (!s || !['available', 'downloading', 'downloaded', 'error'].includes(s.state)) return null
  if (s.state === 'error') {
    return (
      <div className="update-banner error" onClick={p.onOpen} title={s.error}>
        <span>업데이트 확인 실패</span>
        <button className="small-btn">자세히</button>
      </div>
    )
  }
  return (
    <div className={`update-banner ${s.state}`}>
      <div className="update-banner-text">
        <b>v{s.version}</b>
        <span>
          {s.state === 'available' && '새 버전'}
          {s.state === 'downloading' && `내려받는 중 ${Math.round(s.percent ?? 0)}%`}
          {s.state === 'downloaded' && '설치 준비됨'}
        </span>
      </div>
      {s.state === 'downloading' && (
        <div className="plan-bar">
          <span className="plan-fill" style={{ width: `${Math.round(s.percent ?? 0)}%` }} />
        </div>
      )}
      <div className="row">
        {s.state === 'available' && (
          <button className="small-btn primary" onClick={() => window.api.downloadUpdate()}>
            다운로드
          </button>
        )}
        {s.state === 'downloaded' && (
          <button
            className="small-btn primary"
            disabled={p.running}
            title={p.running ? '작업이 끝난 뒤 재시작할 수 있습니다' : ''}
            onClick={() => window.api.installUpdate()}
          >
            재시작하고 설치
          </button>
        )}
        <button className="small-btn" onClick={p.onOpen}>
          자세히
        </button>
      </div>
    </div>
  )
}

/** 설정 창의 "업데이트" 탭 */
export function UpdateTab(p: {
  draft: AppConfig
  status: UpdateStatus | null
  running: boolean
  onChange: (c: AppConfig) => void
}) {
  const [info, setInfo] = useState<{ version: string; packaged: boolean; feed: string; logPath: string } | null>(
    null
  )
  useEffect(() => {
    window.api.updateInfo().then(setInfo)
  }, [p.status?.state, p.draft.update])

  const u = p.draft.update
  const s = p.status
  const set = (patch: Partial<AppConfig['update']>): void =>
    p.onChange({ ...p.draft, update: { ...u, ...patch } })
  const busy = s?.state === 'checking' || s?.state === 'downloading'

  return (
    <div className="form">
      <div className="kv">
        <span>현재 버전</span>
        <b>v{info?.version ?? s?.currentVersion ?? '-'}</b>
      </div>
      <div className="kv">
        <span>업데이트 서버</span>
        <b className="mono small" title={info?.feed}>
          {info?.feed || '미설정'}
        </b>
      </div>
      {info && !info.packaged && (
        <div className="notice warn">
          개발 모드(npm run dev)에서는 확인·다운로드까지만 되고 설치는 설치판에서만 동작합니다.
        </div>
      )}

      <div className={`notice ${s?.state === 'error' ? 'error' : ''}`}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <span>{updateSummary(s)}</span>
          <span className="row">
            <button onClick={() => window.api.checkForUpdate()} disabled={busy || s?.state === 'disabled'}>
              지금 확인
            </button>
            {s?.state === 'available' && (
              <button className="primary" onClick={() => window.api.downloadUpdate()}>
                다운로드
              </button>
            )}
            {s?.state === 'downloaded' && (
              <button className="primary" disabled={p.running} onClick={() => window.api.installUpdate()}>
                재시작하고 설치
              </button>
            )}
          </span>
        </div>
        {s?.state === 'downloading' && (
          <>
            <div className="plan-bar" style={{ marginTop: 8 }}>
              <span className="plan-fill" style={{ width: `${Math.round(s.percent ?? 0)}%` }} />
            </div>
            <div className="muted small">
              {fmtBytes(s.transferred)} / {fmtBytes(s.total)} · {fmtBytes(s.bytesPerSecond)}/s
            </div>
          </>
        )}
        {s?.checkedAt && s.state !== 'downloading' && (
          <div className="muted small" style={{ marginTop: 6 }}>
            마지막 확인 {new Date(s.checkedAt).toLocaleString('ko-KR')}
          </div>
        )}
        {s?.releaseNotes && (s.state === 'available' || s.state === 'downloaded' || s.state === 'downloading') && (
          <pre style={{ marginTop: 8, maxHeight: 160 }}>{s.releaseNotes}</pre>
        )}
      </div>

      <h4>동작</h4>
      <label className="check">
        <input type="checkbox" checked={u.autoCheck} onChange={(e) => set({ autoCheck: e.target.checked })} />
        <div>
          <div className="mode-label">자동으로 확인</div>
          <div className="mode-desc">앱 시작 직후와 4시간마다 새 버전이 있는지 확인합니다.</div>
        </div>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={u.autoDownload}
          onChange={(e) => set({ autoDownload: e.target.checked })}
        />
        <div>
          <div className="mode-label">새 버전은 바로 내려받기</div>
          <div className="mode-desc">끄면 사이드바에 알림만 띄우고, 다운로드 버튼을 눌렀을 때 받습니다.</div>
        </div>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={u.installOnQuit}
          onChange={(e) => set({ installOnQuit: e.target.checked })}
        />
        <div>
          <div className="mode-label">앱을 닫을 때 자동 설치</div>
          <div className="mode-desc">내려받아 둔 업데이트를 종료 시 조용히 설치합니다. "재시작하고 설치"로 바로 적용할 수도 있습니다.</div>
        </div>
      </label>

      <h4>배포 위치</h4>
      <div className="row">
        <label className={u.provider === 'generic' ? 'mode active' : 'mode'} style={{ flex: 1 }}>
          <input type="radio" checked={u.provider === 'generic'} onChange={() => set({ provider: 'generic' })} />
          <div>
            <div className="mode-label">정적 URL</div>
            <div className="mode-desc">latest.yml 과 설치 파일을 올린 폴더 주소</div>
          </div>
        </label>
        <label className={u.provider === 'github' ? 'mode active' : 'mode'} style={{ flex: 1 }}>
          <input type="radio" checked={u.provider === 'github'} onChange={() => set({ provider: 'github' })} />
          <div>
            <div className="mode-label">GitHub Releases</div>
            <div className="mode-desc">공개 저장소의 Releases 에 올린 파일</div>
          </div>
        </label>
      </div>
      {u.provider === 'generic' ? (
        <label className="field">
          <span>업데이트 폴더 URL (비우면 빌드에 포함된 기본 주소)</span>
          <input
            className="text mono"
            placeholder="https://your-server.example.com/claude-cli-studio/updates"
            value={u.url ?? ''}
            onChange={(e) => set({ url: e.target.value })}
          />
        </label>
      ) : (
        <div className="row">
          <label className="field">
            <span>소유자 (owner)</span>
            <input className="text mono" value={u.owner ?? ''} onChange={(e) => set({ owner: e.target.value })} />
          </label>
          <label className="field">
            <span>저장소 (repo)</span>
            <input className="text mono" value={u.repo ?? ''} onChange={(e) => set({ repo: e.target.value })} />
          </label>
        </div>
      )}
      <div className="muted small">
        배포 방법: package.json 의 version 을 올리고 <code>npm run dist</code> 를 실행하면 release/ 에
        latest.yml, Setup exe, exe.blockmap 이 생깁니다. 세 파일을 위 주소에 올리면 설치된 앱이 자동으로
        찾아 받습니다.
      </div>
      {info?.logPath && (
        <button className="link" onClick={() => window.api.openPath(info.logPath)}>
          업데이트 로그 열기 ({info.logPath})
        </button>
      )}
    </div>
  )
}
