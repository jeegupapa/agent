import { useEffect, useRef, useState } from 'react'
import { planName } from './Sidebar'
import { MemoryTab } from '../memory/MemoryTab'
import type { MemoryStore } from '../memory/store'
import type {
  AppConfig,
  AppConfigView,
  AuthStatus,
  McpServerEntry,
  McpTransport,
  SessionInfo,
  SkillInfo,
  SkillScope,
  UpdateStatus
} from '../../../shared/types'
import { UpdateTab } from './UpdatePanel'
import { FirebaseTab } from './FirebasePanel'
import type { FbUser } from '../firebase'

type Tab = 'auth' | 'mcp' | 'skills' | 'update' | 'firebase' | 'memory'

interface Props {
  config: AppConfigView
  session: SessionInfo | null
  cwd: string
  initialTab?: Tab
  updateStatus: UpdateStatus | null
  authStatus: AuthStatus | null
  /** `claude auth status` 를 다시 읽는다 */
  onRefreshAuth: () => Promise<AuthStatus>
  memory: MemoryStore
  running: boolean
  fbUser: FbUser | null
  onSave: (config: AppConfig) => Promise<void>
  onSaveApiKey: (key: string | null) => Promise<void>
  onInsertText: (text: string) => void
  onClose: () => void
}

import { MODELS } from '../models'

function stripView(v: AppConfigView): AppConfig {
  const { hasApiKey: _h, apiKeyHint: _k, ...rest } = v
  return rest
}

/** "KEY=value" 줄들을 객체로 */
function parseKv(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
  return Object.keys(out).length ? out : undefined
}
function kvToText(kv?: Record<string, string>): string {
  return kv ? Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n') : ''
}

/** 공백으로 인자 나누기 (따옴표 묶음 지원) */
function splitArgs(s: string): string[] {
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

export function SettingsDialog(p: Props) {
  const [tab, setTab] = useState<Tab>(p.initialTab ?? 'auth')
  const [draft, setDraft] = useState<AppConfig>(stripView(p.config))
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  useEffect(() => setDraft(stripView(p.config)), [p.config])

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await p.onSave(draft)
      setMsg('저장했습니다. 다음 요청부터 적용됩니다.')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={p.onClose}>
      <div className="modal settings" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h3>연결 설정</h3>
          <button className="ghost" onClick={p.onClose}>
            ✕
          </button>
        </div>
        <div className="tabs">
          <button className={tab === 'auth' ? 'active' : ''} onClick={() => setTab('auth')}>
            API · 인증
          </button>
          <button className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>
            MCP 서버 ({draft.mcpServers.filter((s) => s.enabled).length})
          </button>
          <button className={tab === 'skills' ? 'active' : ''} onClick={() => setTab('skills')}>
            스킬
          </button>
          <button className={tab === 'memory' ? 'active' : ''} onClick={() => setTab('memory')}>
            메모리 ({p.memory.memories.length})
          </button>
          <button className={tab === 'firebase' ? 'active' : ''} onClick={() => setTab('firebase')}>
            Firebase
          </button>
          <button className={tab === 'update' ? 'active' : ''} onClick={() => setTab('update')}>
            업데이트
            {p.updateStatus && ['available', 'downloading', 'downloaded'].includes(p.updateStatus.state) && (
              <i className="dot-new" />
            )}
          </button>
        </div>

        <div className="settings-body">
          {tab === 'auth' && (
            <AuthTab
              draft={draft}
              view={p.config}
              session={p.session}
              authStatus={p.authStatus}
              onRefreshAuth={p.onRefreshAuth}
              onChange={setDraft}
              onSaveApiKey={p.onSaveApiKey}
              setMsg={setMsg}
            />
          )}
          {tab === 'mcp' && <McpTab draft={draft} session={p.session} cwd={p.cwd} onChange={setDraft} />}
          {tab === 'memory' && <MemoryTab store={p.memory} cwd={p.cwd} />}
          {tab === 'firebase' && (
            <FirebaseTab draft={draft} user={p.fbUser} onChange={setDraft} setMsg={setMsg} />
          )}
          {tab === 'update' && (
            <UpdateTab draft={draft} status={p.updateStatus} running={p.running} onChange={setDraft} setMsg={setMsg} />
          )}
          {tab === 'skills' && (
            <SkillsTab
              cwd={p.cwd}
              session={p.session}
              inherit={draft.inheritSettings}
              onInsertText={(t) => {
                p.onInsertText(t)
                p.onClose()
              }}
            />
          )}
        </div>

        <div className="modal-actions settings-foot">
          <span className="muted small">{msg}</span>
          {tab !== 'skills' && (
            <button className="primary" onClick={save} disabled={saving}>
              저장
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------- API · 인증 ----------------

function AuthTab(p: {
  draft: AppConfig
  view: AppConfigView
  session: SessionInfo | null
  authStatus: AuthStatus | null
  onRefreshAuth: () => Promise<AuthStatus>
  onChange: (c: AppConfig) => void
  onSaveApiKey: (key: string | null) => Promise<void>
  setMsg: (s: string) => void
}) {
  const [key, setKey] = useState('')
  const [checking, setChecking] = useState(false)
  // "터미널에서 로그인 열기" 뒤 로그인이 끝나는지 몇 초마다 확인한다
  const pollRef = useRef<number | null>(null)
  useEffect(() => () => { if (pollRef.current) window.clearInterval(pollRef.current) }, [])
  const { draft } = p
  const a = p.authStatus
  const authNow = p.session
    ? p.session.apiKeySource === 'none'
      ? 'claude.ai 로그인(OAuth)'
      : `API 키 (${p.session.apiKeySource})`
    : '아직 요청 없음 (첫 요청 때 확정)'
  const loginLine = !a
    ? '확인 중…'
    : a.loggedIn
      ? `${a.authMethod === 'claude.ai' ? 'claude.ai' : a.authMethod ?? ''} 로그인됨 · ${a.email ?? ''}${a.subscriptionType ? ` · ${planName(a.subscriptionType)}` : ''}${
          a.loginExpiresAt ? ` · ${new Date(a.loginExpiresAt).toLocaleDateString('ko-KR')} 까지` : ''
        }`
      : `로그인 안 됨${a.error ? ` (${a.error})` : ''}`

  const refresh = async (): Promise<void> => {
    setChecking(true)
    try {
      const st = await p.onRefreshAuth()
      p.setMsg(st.loggedIn ? `로그인 확인: ${st.email ?? ''} ${st.subscriptionType ? planName(st.subscriptionType) : ''}` : '아직 로그인되어 있지 않습니다.')
    } finally {
      setChecking(false)
    }
  }
  const startPolling = (): void => {
    if (pollRef.current) window.clearInterval(pollRef.current)
    const started = Date.now()
    pollRef.current = window.setInterval(async () => {
      const st = await p.onRefreshAuth()
      if (st.loggedIn || Date.now() - started > 3 * 60_000) {
        if (pollRef.current) window.clearInterval(pollRef.current)
        pollRef.current = null
        if (st.loggedIn) p.setMsg(`로그인 완료: ${st.email ?? ''} ${st.subscriptionType ? planName(st.subscriptionType) : ''}. 다음 요청부터 이 계정의 플랜으로 실행됩니다.`)
      }
    }, 3000)
  }

  return (
    <div className="form">
      <div className="kv">
        <span>claude.ai 로그인 상태</span>
        <b className={a && !a.loggedIn ? 'warn' : ''}>{loginLine}</b>
        <button className="small-btn" disabled={checking} onClick={refresh}>
          {checking ? '확인 중…' : '다시 확인'}
        </button>
      </div>
      <div className="kv">
        <span>현재 세션 인증</span>
        <b>{authNow}</b>
      </div>
      <div className="muted small">
        플랜 사용량 막대(사이드바)는 Claude 가 요청마다 보내 주는 한도 정보로 그려지므로 첫 요청 뒤에 나타납니다. 로그인만 되어
        있으면 요청 없이도 위 줄에 플랜 종류가 보입니다.
      </div>

      <h4>인증 방식</h4>
      <label className={draft.auth.mode === 'oauth' ? 'mode active' : 'mode'}>
        <input
          type="radio"
          checked={draft.auth.mode === 'oauth'}
          onChange={() => p.onChange({ ...draft, auth: { ...draft.auth, mode: 'oauth' } })}
        />
        <div>
          <div className="mode-label">claude.ai 구독 로그인</div>
          <div className="mode-desc">Pro / Max 플랜 한도를 사용. 터미널에서 한 번 로그인하면 됩니다.</div>
          <button
            className="small-btn"
            onClick={async () => {
              const exe = await window.api.loginInTerminal()
              p.setMsg(`새 콘솔 창에서 로그인을 진행하세요 (${exe}). 끝나면 여기서 자동으로 확인합니다.`)
              startPolling()
            }}
          >
            터미널에서 로그인 열기
          </button>
        </div>
      </label>
      <label className={draft.auth.mode === 'apiKey' ? 'mode active' : 'mode'}>
        <input
          type="radio"
          checked={draft.auth.mode === 'apiKey'}
          onChange={() => p.onChange({ ...draft, auth: { ...draft.auth, mode: 'apiKey' } })}
        />
        <div style={{ flex: 1 }}>
          <div className="mode-label">Anthropic API 키</div>
          <div className="mode-desc">
            종량제 과금. 키는 이 PC의 자격 증명 저장소에 암호화되어 보관되며 화면에 다시 표시되지 않습니다.
          </div>
          <div className="row">
            <input
              type="password"
              className="text"
              placeholder={p.view.hasApiKey ? `저장됨 (끝자리 …${p.view.apiKeyHint})` : 'sk-ant-…'}
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoComplete="off"
            />
            <button
              disabled={!key.trim()}
              onClick={async () => {
                await p.onSaveApiKey(key)
                setKey('')
                p.setMsg('API 키를 저장했습니다.')
              }}
            >
              키 저장
            </button>
            {p.view.hasApiKey && (
              <button
                className="danger"
                onClick={async () => {
                  await p.onSaveApiKey(null)
                  p.setMsg('API 키를 삭제했습니다.')
                }}
              >
                삭제
              </button>
            )}
          </div>
        </div>
      </label>

      <h4>고급</h4>
      <label className="field">
        <span>기본 URL (프록시 / 게이트웨이, 비우면 기본)</span>
        <input
          className="text"
          placeholder="https://api.anthropic.com"
          value={draft.auth.baseUrl ?? ''}
          onChange={(e) => p.onChange({ ...draft, auth: { ...draft.auth, baseUrl: e.target.value } })}
        />
      </label>
      <label className="field">
        <span>모델</span>
        <select
          className="text"
          value={draft.model ?? ''}
          onChange={(e) => p.onChange({ ...draft, model: e.target.value || undefined })}
        >
          {MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.inheritSettings}
          onChange={(e) => p.onChange({ ...draft, inheritSettings: e.target.checked })}
        />
        <div>
          <div className="mode-label">Claude Code 설정 상속</div>
          <div className="mode-desc">
            ~/.claude 와 프로젝트 .claude 의 settings.json, CLAUDE.md, MCP 서버, 스킬, 플러그인을 터미널
            CLI 와 똑같이 불러옵니다. 끄면 이 앱에서 등록한 MCP 서버만 씁니다.
          </div>
        </div>
      </label>
    </div>
  )
}

// ---------------- MCP ----------------

const EMPTY_MCP: McpServerEntry = { name: '', enabled: true, type: 'stdio', command: '', args: [] }

function McpTab(p: {
  draft: AppConfig
  session: SessionInfo | null
  cwd: string
  onChange: (c: AppConfig) => void
}) {
  const [editing, setEditing] = useState<number | null>(null)
  const [form, setForm] = useState<McpServerEntry>(EMPTY_MCP)
  const [argsText, setArgsText] = useState('')
  const [envText, setEnvText] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [importMsg, setImportMsg] = useState('')

  const statusOf = (name: string): string | undefined =>
    p.session?.mcpServers.find((s) => s.name === name)?.status

  const startEdit = (idx: number | null): void => {
    const s = idx === null ? EMPTY_MCP : p.draft.mcpServers[idx]
    setEditing(idx ?? -1)
    setForm({ ...s })
    setArgsText((s.args ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '))
    setEnvText(kvToText(s.env))
    setHeadersText(kvToText(s.headers))
  }

  const commit = (): void => {
    if (!form.name.trim()) return
    const entry: McpServerEntry = {
      ...form,
      name: form.name.trim(),
      args: form.type === 'stdio' ? splitArgs(argsText) : undefined,
      env: form.type === 'stdio' ? parseKv(envText) : undefined,
      headers: form.type !== 'stdio' ? parseKv(headersText) : undefined
    }
    const list = [...p.draft.mcpServers]
    if (editing === -1 || editing === null) list.push(entry)
    else list[editing] = entry
    p.onChange({ ...p.draft, mcpServers: list })
    setEditing(null)
  }

  const remove = (idx: number): void => {
    p.onChange({ ...p.draft, mcpServers: p.draft.mcpServers.filter((_, i) => i !== idx) })
  }

  const toggle = (idx: number): void => {
    const list = p.draft.mcpServers.map((s, i) => (i === idx ? { ...s, enabled: !s.enabled } : s))
    p.onChange({ ...p.draft, mcpServers: list })
  }

  const importFromClaude = async (): Promise<void> => {
    const found = await window.api.importClaudeMcp(p.cwd)
    const existing = new Set(p.draft.mcpServers.map((s) => s.name))
    const added = found.filter((s) => !existing.has(s.name))
    p.onChange({ ...p.draft, mcpServers: [...p.draft.mcpServers, ...added] })
    setImportMsg(
      found.length === 0
        ? '~/.claude.json 에 등록된 MCP 서버가 없습니다.'
        : `${added.length}개 가져옴 (${found.length - added.length}개는 이미 있음). 저장을 눌러 확정하세요.`
    )
  }

  // 설정 상속으로 들어온 서버(앱 목록에 없는 것)
  const inherited = (p.session?.mcpServers ?? []).filter(
    (s) => !p.draft.mcpServers.some((d) => d.name === s.name)
  )

  return (
    <div className="form">
      <div className="row">
        <button className="primary" onClick={() => startEdit(null)}>
          + MCP 서버 추가
        </button>
        <button onClick={importFromClaude}>Claude Code 설정에서 가져오기</button>
        <span className="muted small">{importMsg}</span>
      </div>

      <ul className="mcp-list">
        {p.draft.mcpServers.length === 0 && <li className="muted">앱에 등록된 MCP 서버가 없습니다.</li>}
        {p.draft.mcpServers.map((s, idx) => {
          const st = statusOf(s.name)
          return (
            <li key={s.name + idx} className={s.enabled ? '' : 'disabled'}>
              <input type="checkbox" checked={s.enabled} onChange={() => toggle(idx)} title="사용" />
              <div className="mcp-main">
                <div className="mcp-name">
                  <b>{s.name}</b>
                  <span className="badge">{s.type}</span>
                  {st && <span className={`state ${st === 'connected' ? 'done' : 'error'}`}>{st}</span>}
                </div>
                <div className="mono small muted">
                  {s.type === 'stdio' ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}` : s.url}
                </div>
              </div>
              <button className="small-btn" onClick={() => startEdit(idx)}>
                편집
              </button>
              <button className="small-btn danger" onClick={() => remove(idx)}>
                삭제
              </button>
            </li>
          )
        })}
        {inherited.map((s) => (
          <li key={'inh-' + s.name} className="inherited">
            <span className="badge">상속</span>
            <div className="mcp-main">
              <div className="mcp-name">
                <b>{s.name}</b>
                <span className={`state ${s.status === 'connected' ? 'done' : 'error'}`}>{s.status}</span>
              </div>
              <div className="small muted">Claude Code 설정(~/.claude.json 또는 .mcp.json)에서 불러옴</div>
            </div>
          </li>
        ))}
      </ul>

      {editing !== null && (
        <div className="mcp-form">
          <h4>{editing === -1 ? '새 MCP 서버' : 'MCP 서버 편집'}</h4>
          <div className="row">
            <label className="field">
              <span>이름</span>
              <input
                className="text"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="filesystem"
              />
            </label>
            <label className="field">
              <span>전송 방식</span>
              <select
                className="text"
                value={form.type}
                onChange={(e) => setForm({ ...form, type: e.target.value as McpTransport })}
              >
                <option value="stdio">stdio (로컬 명령)</option>
                <option value="http">http (원격)</option>
                <option value="sse">sse (원격, 구형)</option>
              </select>
            </label>
          </div>
          {form.type === 'stdio' ? (
            <>
              <label className="field">
                <span>명령</span>
                <input
                  className="text mono"
                  value={form.command ?? ''}
                  onChange={(e) => setForm({ ...form, command: e.target.value })}
                  placeholder="npx"
                />
              </label>
              <label className="field">
                <span>인자 (공백 구분, 따옴표 가능)</span>
                <input
                  className="text mono"
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder='-y @modelcontextprotocol/server-filesystem "C:\\작업 폴더"'
                />
              </label>
              <label className="field">
                <span>환경 변수 (한 줄에 KEY=value)</span>
                <textarea className="text mono" rows={3} value={envText} onChange={(e) => setEnvText(e.target.value)} />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>URL</span>
                <input
                  className="text mono"
                  value={form.url ?? ''}
                  onChange={(e) => setForm({ ...form, url: e.target.value })}
                  placeholder="https://mcp.example.com/mcp"
                />
              </label>
              <label className="field">
                <span>헤더 (한 줄에 Name=value, 예: Authorization=Bearer …)</span>
                <textarea
                  className="text mono"
                  rows={3}
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                />
              </label>
            </>
          )}
          <div className="row">
            <button className="primary" onClick={commit} disabled={!form.name.trim()}>
              {editing === -1 ? '추가' : '적용'}
            </button>
            <button onClick={() => setEditing(null)}>취소</button>
            <span className="muted small">목록에 반영한 뒤 아래 저장을 눌러야 파일에 기록됩니다.</span>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------- 스킬 ----------------

function SkillsTab(p: {
  cwd: string
  session: SessionInfo | null
  inherit: boolean
  onInsertText: (t: string) => void
}) {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [creating, setCreating] = useState(false)
  const [scope, setScope] = useState<SkillScope>('user')
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [body, setBody] = useState('')
  const [err, setErr] = useState('')

  const reload = (): void => {
    window.api.listSkills(p.cwd).then(setSkills)
  }
  useEffect(reload, [p.cwd])

  const create = async (): Promise<void> => {
    setErr('')
    try {
      await window.api.createSkill({ scope, cwd: p.cwd, name, description: desc, body })
      setCreating(false)
      setName('')
      setDesc('')
      setBody('')
      reload()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }

  const slash = p.session?.slashCommands ?? []

  return (
    <div className="form">
      {!p.inherit && (
        <div className="notice warn">
          "Claude Code 설정 상속"이 꺼져 있어 아래 스킬이 세션에 로드되지 않습니다. API · 인증 탭에서 켜 주세요.
        </div>
      )}
      <div className="row">
        <button className="primary" onClick={() => setCreating((v) => !v)}>
          + 새 스킬 만들기
        </button>
        <button onClick={() => window.api.openSkillsFolder('user', p.cwd)}>사용자 스킬 폴더 열기</button>
        <button onClick={() => window.api.openSkillsFolder('project', p.cwd)}>프로젝트 스킬 폴더 열기</button>
        <button onClick={reload}>새로고침</button>
      </div>

      {creating && (
        <div className="mcp-form">
          <h4>새 스킬</h4>
          <div className="row">
            <label className="field">
              <span>범위</span>
              <select className="text" value={scope} onChange={(e) => setScope(e.target.value as SkillScope)}>
                <option value="user">사용자 전역 (~/.claude/skills)</option>
                <option value="project">이 프로젝트 (.claude/skills)</option>
              </select>
            </label>
            <label className="field">
              <span>이름 (영문 소문자·숫자·하이픈)</span>
              <input className="text mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="my-review" />
            </label>
          </div>
          <label className="field">
            <span>설명 (Claude가 언제 쓸지 판단하는 문장)</span>
            <input
              className="text"
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="코드 리뷰를 요청받았을 때 우리 팀 체크리스트대로 검토한다"
            />
          </label>
          <label className="field">
            <span>지침 본문 (마크다운)</span>
            <textarea
              className="text"
              rows={8}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={'# 리뷰 절차\n1. ...\n2. ...'}
            />
          </label>
          {err && <div className="notice error">{err}</div>}
          <div className="row">
            <button className="primary" onClick={create} disabled={!name.trim() || !desc.trim()}>
              만들기
            </button>
            <button onClick={() => setCreating(false)}>취소</button>
          </div>
        </div>
      )}

      <h4>설치된 스킬 ({skills.length})</h4>
      <ul className="skill-list">
        {skills.length === 0 && <li className="muted">스킬이 없습니다. 위에서 새로 만들거나 폴더에 SKILL.md 를 넣으세요.</li>}
        {skills.map((s) => (
          <li key={s.path}>
            <div className="mcp-main">
              <div className="mcp-name">
                <b>/{s.name}</b>
                <span className="badge">{s.scope === 'user' ? '전역' : '프로젝트'}</span>
              </div>
              <div className="small muted">{s.description || '(설명 없음)'}</div>
            </div>
            <button className="small-btn" onClick={() => p.onInsertText(`/${s.name} `)}>
              채팅에 넣기
            </button>
            <button className="small-btn" onClick={() => window.api.openPath(s.path)}>
              폴더
            </button>
          </li>
        ))}
      </ul>

      {slash.length > 0 && (
        <>
          <h4>이 세션에서 쓸 수 있는 슬래시 명령 ({slash.length})</h4>
          <div className="chips">
            {slash.map((c) => (
              <button key={c} className="chip" onClick={() => p.onInsertText(`/${c} `)}>
                /{c}
              </button>
            ))}
          </div>
        </>
      )}
      {p.session && p.session.plugins.length > 0 && (
        <>
          <h4>플러그인 ({p.session.plugins.length})</h4>
          <div className="chips">
            {p.session.plugins.map((pl) => (
              <span key={pl.name} className="chip static" title={pl.path}>
                {pl.name}
                {pl.version ? ` v${pl.version}` : ''}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
