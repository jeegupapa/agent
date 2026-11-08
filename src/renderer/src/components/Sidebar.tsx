import { useEffect, useState } from 'react'
import type {
  AppConfigView,
  PermissionMode,
  PlanWindow,
  SavedSessionMeta,
  SessionInfo,
  UpdateStatus,
  UsageSummary
} from '../../../shared/types'
import type { PlanUsage } from '../App'
import { UpdateBanner } from './UpdatePanel'
import { SessionHistory, type SyncState } from './FirebasePanel'
import { MODELS } from '../models'
import type { FbUser } from '../firebase'

interface Props {
  cwd: string
  session: SessionInfo | null
  config: AppConfigView | null
  permissionMode: PermissionMode
  usage: UsageSummary
  plan: PlanUsage | null
  running: boolean
  updateStatus: UpdateStatus | null
  mode: 'chat' | 'team'
  teamSummary: { running: number; attention: number }
  onModeChange: (m: 'chat' | 'team') => void
  history: {
    enabled: boolean
    cwd: string
    user: FbUser | null
    sessions: SavedSessionMeta[]
    currentId?: string
    hostname: string
    sync: SyncState
    onOpen: (id: string) => void
    onDelete: (id: string) => void
  }
  onPickFolder: () => void
  onNewSession: () => void
  onPermissionModeChange: (mode: PermissionMode) => void
  /** 기본 모델 변경 (설정에 저장) */
  onModelChange: (model: string | undefined) => void
  onOpenSettings: (tab: 'auth' | 'mcp' | 'skills' | 'update' | 'firebase') => void
}

const MODES: { value: PermissionMode; label: string; desc: string }[] = [
  { value: 'default', label: '기본', desc: '파일 수정·명령 실행 전 매번 확인' },
  { value: 'acceptEdits', label: '편집 자동 승인', desc: '파일 편집은 자동, 명령은 확인' },
  { value: 'plan', label: '플랜 모드', desc: '계획만 세우고 실행하지 않음' },
  { value: 'bypassPermissions', label: '모두 허용', desc: '확인 없이 모두 실행 (주의)' }
]

/** 한도 창 종류 → 표시 이름과 정렬 순서 */
const WINDOW_META: Record<string, { label: string; order: number }> = {
  five_hour: { label: '5시간 한도', order: 0 },
  seven_day: { label: '주간 한도 (전체)', order: 1 },
  seven_day_opus: { label: '주간 한도 (Opus)', order: 2 },
  seven_day_sonnet: { label: '주간 한도 (Sonnet)', order: 3 },
  seven_day_overage_included: { label: '주간 한도 (추가 사용 포함)', order: 4 },
  overage: { label: '추가 사용', order: 5 }
}

function windowLabel(type: string): string {
  return WINDOW_META[type]?.label ?? type
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

/** "3일 4시간 후" / "52분 후" / "초기화됨" */
function fmtUntil(ms: number | undefined, now: number): string {
  if (!ms) return ''
  const diff = ms - now
  if (diff <= 0) return '초기화됨'
  const min = Math.floor(diff / 60_000)
  const h = Math.floor(min / 60)
  const d = Math.floor(h / 24)
  if (d > 0) return `${d}일 ${h % 24}시간 후 초기화`
  if (h > 0) return `${h}시간 ${min % 60}분 후 초기화`
  return `${Math.max(min, 1)}분 후 초기화`
}

function fmtResetTime(ms: number | undefined): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString('ko-KR', {
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function barClass(w: PlanWindow): string {
  if (w.status === 'rejected' || w.utilization >= 0.9) return 'plan-fill danger'
  if (w.status === 'allowed_warning' || w.utilization >= 0.7) return 'plan-fill warn'
  return 'plan-fill'
}

export function PlanUsageView({ plan }: { plan: PlanUsage | null }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  if (!plan || plan.windows.length === 0) {
    return <div className="muted small">첫 요청 후 플랜 한도가 표시됩니다. (API 키 모드에서는 표시되지 않음)</div>
  }

  const windows = [...plan.windows].sort(
    (a, b) => (WINDOW_META[a.type]?.order ?? 99) - (WINDOW_META[b.type]?.order ?? 99)
  )

  return (
    <div className="plan">
      {windows.map((w) => {
        const pct = Math.min(100, Math.max(0, Math.round(w.utilization * 100)))
        return (
          <div key={w.type} className="plan-window" title={fmtResetTime(w.resetsAt)}>
            <div className="plan-head">
              <span>{windowLabel(w.type)}</span>
              <b className={pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : ''}>{pct}%</b>
            </div>
            <div className="plan-bar">
              <span className={barClass(w)} style={{ width: `${pct}%` }} />
            </div>
            <div className="plan-foot">
              <span>{fmtUntil(w.resetsAt, now)}</span>
              {w.status === 'rejected' && <span className="danger">한도 초과</span>}
            </div>
          </div>
        )
      })}
      {plan.isUsingOverage && <div className="small warn">추가 사용(overage) 요금이 적용 중입니다.</div>}
      <div className="muted small">
        {new Date(plan.updatedAt).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })} 기준
      </div>
    </div>
  )
}

/** 인증·MCP·스킬 연결 상태 요약 */
function ConnectionView(p: Props) {
  const cfg = p.config
  const s = p.session
  const authLabel = !cfg
    ? '-'
    : cfg.auth.mode === 'apiKey'
      ? cfg.hasApiKey
        ? `API 키 (…${cfg.apiKeyHint})`
        : 'API 키 (미설정!)'
      : 'claude.ai 로그인'
  const authLive = s ? (s.apiKeySource === 'none' ? 'OAuth 확인됨' : `키: ${s.apiKeySource}`) : ''
  const appMcp = cfg?.mcpServers.filter((m) => m.enabled).length ?? 0
  const mcpList = s?.mcpServers ?? []
  const skillCount = s?.skills.length ?? 0
  const connected = mcpList.filter((m) => m.status === 'connected').length

  return (
    <div className="conn">
      <div className="conn-row">
        <span>인증</span>
        <b title={authLive}>{authLabel}</b>
      </div>
      <div className="conn-row" title={s?.model ? `현재 세션: ${s.model}` : '다음 요청부터 적용'}>
        <span>모델</span>
        <select
          className="text inline"
          value={cfg?.model ?? ''}
          disabled={!cfg || p.running}
          onChange={(e) => p.onModelChange(e.target.value || undefined)}
        >
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      <div className="conn-row">
        <span>MCP 서버</span>
        <b>
          {s ? `${connected}/${mcpList.length} 연결됨` : `${appMcp}개 등록`}
          {cfg?.inheritSettings ? '' : ' (상속 꺼짐)'}
        </b>
      </div>
      {mcpList.length > 0 && (
        <div className="conn-mcp">
          {mcpList.map((m) => (
            <div key={m.name} title={m.source ?? ''}>
              <span>
                <i className={m.status === 'connected' ? 'dot-ok' : 'dot-err'} />
                {m.name}
              </span>
              <span className="muted">{m.status}</span>
            </div>
          ))}
        </div>
      )}
      <div
        className="conn-row"
        title={
          s
            ? `세션이 알려준 값입니다.\n스킬(${skillCount}): ${s.skills.join(', ') || '없음'}\n슬래시 명령(${s.slashCommands.length}, 입력창에 / 로 선택): ${s.slashCommands.join(', ') || '없음'}`
            : '설치된 스킬 수 / 쓸 수 있는 슬래시 명령 수. Claude Code 세션이 시작된 뒤(첫 메시지 이후) 세션이 알려줍니다.'
        }
      >
        <span>스킬 / 명령</span>
        <b>{s ? `${skillCount}개 / ${s.slashCommands.length}개` : <span className="muted">세션 시작 후 표시</span>}</b>
      </div>
      <div className="row">
        <button className="small-btn" onClick={() => p.onOpenSettings('auth')}>
          API · 인증
        </button>
        <button className="small-btn" onClick={() => p.onOpenSettings('mcp')}>
          MCP
        </button>
        <button className="small-btn" onClick={() => p.onOpenSettings('skills')}>
          스킬
        </button>
      </div>
    </div>
  )
}

export function Sidebar(p: Props) {
  const [showTokens, setShowTokens] = useState(false)
  const totalTokens =
    p.usage.inputTokens + p.usage.outputTokens + p.usage.cacheReadTokens + p.usage.cacheCreationTokens
  const pct = (n: number): string => (totalTokens ? ((n / totalTokens) * 100).toFixed(0) + '%' : '0%')

  return (
    <aside className="sidebar">
      <h1 className="logo">
        <span className="dot" /> Claude CLI Studio
      </h1>
      <UpdateBanner status={p.updateStatus} running={p.running} onOpen={() => p.onOpenSettings('update')} />

      <div className="mode-switch">
        <button className={p.mode === 'chat' ? 'active' : ''} onClick={() => p.onModeChange('chat')}>
          💬 채팅
        </button>
        <button className={p.mode === 'team' ? 'active' : ''} onClick={() => p.onModeChange('team')}>
          👥 팀
          {p.teamSummary.running > 0 && <span className="pill warn">{p.teamSummary.running}</span>}
          {p.teamSummary.attention > 0 && <span className="pill danger">{p.teamSummary.attention}</span>}
        </button>
      </div>

      <section>
        <h2>작업 폴더</h2>
        <div className="cwd" title={p.cwd}>
          {p.cwd || '(선택 안 됨)'}
        </div>
        <div className="row">
          <button onClick={p.onPickFolder} disabled={p.running}>
            폴더 선택…
          </button>
          <button onClick={p.onNewSession} disabled={p.running}>
            새 세션
          </button>
        </div>
        {p.session && (
          <div className="kv small">
            <span>세션 ID</span>
            <b className="mono" title={p.session.sessionId}>
              {p.session.sessionId.slice(0, 8)}…
            </b>
          </div>
        )}
      </section>

      <section>
        <h2>연결</h2>
        <ConnectionView {...p} />
      </section>

      <section>
        <h2>세션 기록</h2>
        <SessionHistory {...p.history} running={p.running} onOpenSettings={() => p.onOpenSettings('firebase')} />
      </section>

      <section>
        <h2>권한 모드</h2>
        <div className="modes">
          {MODES.map((m) => (
            <label key={m.value} className={p.permissionMode === m.value ? 'mode active' : 'mode'}>
              <input
                type="radio"
                name="mode"
                value={m.value}
                checked={p.permissionMode === m.value}
                onChange={() => p.onPermissionModeChange(m.value)}
                disabled={p.running}
              />
              <div>
                <div className="mode-label">{m.label}</div>
                <div className="mode-desc">{m.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </section>

      <section>
        <h2>플랜 사용량</h2>
        <PlanUsageView plan={p.plan} />
      </section>

      <section>
        <h2>이번 세션</h2>
        <div className="kv">
          <span>턴 수</span>
          <b>{p.usage.numTurns}</b>
        </div>
        <div className="kv">
          <span>소요 시간</span>
          <b>{(p.usage.durationMs / 1000).toFixed(1)}s</b>
        </div>
        <div className="kv">
          <span>토큰 합계</span>
          <b>{fmtTokens(totalTokens)}</b>
        </div>
        <button className="link" onClick={() => setShowTokens((v) => !v)}>
          {showTokens ? '토큰 상세 숨기기' : '토큰 상세 보기'}
        </button>
        {showTokens && (
          <>
            <div className="token-bar" title="입력 / 출력 / 캐시 읽기 / 캐시 생성">
              <span className="t-in" style={{ width: pct(p.usage.inputTokens) }} />
              <span className="t-out" style={{ width: pct(p.usage.outputTokens) }} />
              <span className="t-cr" style={{ width: pct(p.usage.cacheReadTokens) }} />
              <span className="t-cc" style={{ width: pct(p.usage.cacheCreationTokens) }} />
            </div>
            <div className="legend">
              <span>
                <i className="t-in" /> 입력 {fmtTokens(p.usage.inputTokens)}
              </span>
              <span>
                <i className="t-out" /> 출력 {fmtTokens(p.usage.outputTokens)}
              </span>
              <span>
                <i className="t-cr" /> 캐시 읽기 {fmtTokens(p.usage.cacheReadTokens)}
              </span>
              <span>
                <i className="t-cc" /> 캐시 생성 {fmtTokens(p.usage.cacheCreationTokens)}
              </span>
            </div>
            <div
              className="kv muted small"
              title="API 종량제 기준 추정치. 구독 플랜에서는 실제 청구와 무관합니다."
            >
              <span>API 환산 추정</span>
              <b>${p.usage.totalCostUsd.toFixed(2)}</b>
            </div>
          </>
        )}
      </section>

      <div className="sidebar-foot muted small">
        <span>v{p.updateStatus?.currentVersion ?? '-'}</span>
        <button className="link" onClick={() => p.onOpenSettings('update')}>
          {p.updateStatus?.state === 'checking' ? '확인 중…' : '업데이트 확인'}
        </button>
      </div>
    </aside>
  )
}
