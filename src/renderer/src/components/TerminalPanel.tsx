import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/**
 * 오른쪽 패널의 터미널 탭.
 *
 * xterm 인스턴스와 그 DOM 은 모듈 범위의 레지스트리에 두어서, 다른 탭으로 갔다가 돌아와도
 * 화면 내용과 스크롤백이 유지된다 (컴포넌트는 마운트될 때 저장된 요소를 다시 붙이기만 한다).
 * PTY 는 메인 프로세스에서 돌고, 출력은 `term:event` 로 받는다.
 */

interface Entry {
  /** 패널 안에서의 고유 키 (PTY 를 다시 시작해도 유지) */
  key: string
  /** 메인 프로세스의 PTY id. 종료되면 null */
  ptyId: string | null
  title: string
  cwd: string
  term: Terminal
  fit: FitAddon
  el: HTMLDivElement
  exitCode: number | null
  spawning: boolean
}

const entries: Entry[] = []
const listeners = new Set<() => void>()
let seq = 0
let subscribed = false

function notify(): void {
  for (const l of listeners) l()
}

function byPty(id: string): Entry | undefined {
  return entries.find((e) => e.ptyId === id)
}

/** 메인에서 오는 PTY 이벤트 구독 (한 번만) */
function ensureSubscribed(): void {
  if (subscribed) return
  subscribed = true
  window.api.onTermEvent((ev) => {
    const e = byPty(ev.id)
    if (!e) return
    if (ev.kind === 'data') {
      e.term.write(ev.data)
    } else {
      e.exitCode = ev.exitCode
      e.ptyId = null
      e.term.write(`\r\n\x1b[90m[프로세스가 종료되었습니다 (코드 ${ev.exitCode}). Enter 를 누르면 다시 시작합니다]\x1b[0m\r\n`)
      notify()
    }
  })
}

const THEME = {
  background: '#0f1115',
  foreground: '#e6e9ef',
  cursor: '#d97757',
  cursorAccent: '#0f1115',
  selectionBackground: 'rgba(217, 119, 87, 0.35)',
  black: '#1e232d',
  brightBlack: '#8b93a5',
  red: '#e5534b',
  green: '#4caf7d',
  yellow: '#e3b341',
  blue: '#6fa8ff',
  magenta: '#c678dd',
  cyan: '#2bb3c0',
  white: '#e6e9ef'
}

async function spawnInto(e: Entry): Promise<void> {
  if (e.spawning || e.ptyId) return
  e.spawning = true
  const cols = e.term.cols || 80
  const rows = e.term.rows || 24
  try {
    const r = await window.api.termCreate({ cwd: e.cwd, cols, rows })
    e.ptyId = r.id
    e.cwd = r.cwd
    e.exitCode = null
    if (e.title === '터미널' || /^(pwsh|powershell|bash|zsh|sh|fish)/.test(e.title)) e.title = r.shell
  } catch (err) {
    // 실패하면 "종료됨" 상태로 두어 Enter 로 다시 시도할 수 있게 한다
    e.exitCode = -1
    e.term.write(`\r\n\x1b[31m터미널을 시작하지 못했습니다: ${err instanceof Error ? err.message : String(err)}\x1b[0m\r\n`)
  } finally {
    e.spawning = false
  }
  notify()
}

function createEntry(cwd: string): Entry {
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "'Cascadia Code', 'JetBrains Mono', Consolas, 'D2Coding', monospace",
    fontSize: 13,
    lineHeight: 1.2,
    theme: THEME,
    scrollback: 5000,
    allowProposedApi: true
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const el = document.createElement('div')
  el.className = 'term-el'
  const e: Entry = { key: `t${++seq}`, ptyId: null, title: '터미널', cwd, term, fit, el, exitCode: null, spawning: false }
  term.onData((data) => {
    if (e.ptyId) window.api.termWrite(e.ptyId, data)
    else if (data === '\r') {
      // 종료된 셸에서 Enter → 같은 탭에서 다시 시작
      term.write('\r\n')
      void spawnInto(e)
    }
  })
  term.onTitleChange((t) => {
    if (t.trim()) {
      e.title = shortTitle(t)
      notify()
    }
  })
  // Ctrl+C: 선택이 있으면 복사, 없으면 셸로 전달. Ctrl+Shift+C/V 도 복사/붙여넣기
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true
    if (ev.ctrlKey && !ev.altKey && (ev.key === 'c' || ev.key === 'C') && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection())
      if (!ev.shiftKey) term.clearSelection()
      return false
    }
    if (ev.ctrlKey && ev.shiftKey && (ev.key === 'v' || ev.key === 'V')) {
      void navigator.clipboard.readText().then((t) => t && term.paste(t))
      return false
    }
    return true
  })
  entries.push(e)
  return e
}

function removeEntry(e: Entry): void {
  const i = entries.indexOf(e)
  if (i >= 0) entries.splice(i, 1)
  if (e.ptyId) void window.api.termKill(e.ptyId)
  e.term.dispose()
  e.el.remove()
  notify()
}

interface Props {
  cwd: string
  /** 탭이 보이는 중인지 (숨겨진 동안에는 크기를 다시 맞추지 않는다) */
  visible: boolean
  /** 선택한 텍스트를 채팅 입력창으로 */
  onInsertText: (text: string) => void
}

export function TerminalPanel(p: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [, setVersion] = useState(0)
  const [activeKey, setActiveKey] = useState<string | null>(() => entries[0]?.key ?? null)
  const active = entries.find((e) => e.key === activeKey) ?? entries[0] ?? null

  useEffect(() => {
    ensureSubscribed()
    const l = (): void => setVersion((v) => v + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])

  // 첫 진입: 터미널이 없으면 하나 만든다
  useEffect(() => {
    if (entries.length === 0) {
      const e = createEntry(p.cwd)
      setActiveKey(e.key)
    } else if (!activeKey) setActiveKey(entries[0].key)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 활성 터미널의 DOM 을 host 에 붙이고 크기를 맞춘다
  useEffect(() => {
    const host = hostRef.current
    if (!host || !active) return
    host.replaceChildren(active.el)
    if (!active.el.dataset['opened']) {
      active.el.dataset['opened'] = '1'
      active.term.open(active.el)
    }
    const fitNow = (): void => {
      // 탭이 숨겨져 크기가 0 이면 맞추지 않는다 (PTY 가 2x1 로 줄어 출력이 깨진다)
      if (host.offsetWidth < 40 || host.offsetHeight < 20) return
      try {
        active.fit.fit()
        if (active.ptyId) window.api.termResize(active.ptyId, active.term.cols, active.term.rows)
      } catch {
        /* 숨겨진 상태 */
      }
    }
    fitNow()
    if (!active.ptyId && active.exitCode === null) void spawnInto(active)
    active.term.focus()
    let timer: number | undefined
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(fitNow, 60)
    })
    ro.observe(host)
    return () => {
      ro.disconnect()
      window.clearTimeout(timer)
    }
  }, [active])

  // 탭으로 돌아오면 입력 포커스를 터미널에
  useEffect(() => {
    if (p.visible) active?.term.focus()
  }, [p.visible, active])

  const newTerminal = (): void => {
    const e = createEntry(p.cwd)
    setActiveKey(e.key)
  }
  const close = (e: Entry): void => {
    const idx = entries.indexOf(e)
    removeEntry(e)
    if (activeKey === e.key) setActiveKey(entries[Math.max(0, idx - 1)]?.key ?? null)
  }
  const sendSelection = (): void => {
    const sel = active?.term.getSelection().trim()
    if (!sel) return
    p.onInsertText(sel.includes('\n') ? '```\n' + sel + '\n```' : sel)
  }
  const cdHere = (): void => {
    if (!active?.ptyId) return
    const q = p.cwd.includes(' ') ? `"${p.cwd}"` : p.cwd
    window.api.termWrite(active.ptyId, `cd ${q}\r`)
    active.term.focus()
  }

  return (
    <div className="term-panel">
      <div className="term-tabs">
        {entries.map((e) => (
          <div key={e.key} className={`term-tab ${e === active ? 'active' : ''} ${e.exitCode !== null ? 'exited' : ''}`} onClick={() => setActiveKey(e.key)} title={e.cwd}>
            <span className="term-tab-title">{e.title}</span>
            <button className="term-tab-close" title="터미널 닫기" onClick={(ev) => { ev.stopPropagation(); close(e) }}>×</button>
          </div>
        ))}
        <button className="term-tab-add" title="새 터미널 (현재 작업 폴더에서)" onClick={newTerminal}>+</button>
        <span className="term-spacer" />
        <button className="pbtn" title="현재 작업 폴더로 이동 (cd)" onClick={cdHere} disabled={!active?.ptyId}>📂 cd</button>
        <button className="pbtn" title="터미널에서 선택한 텍스트를 채팅 입력창에 넣기" onClick={sendSelection} disabled={!active}>선택 → 채팅</button>
        <button className="pbtn" title="화면 지우기" onClick={() => active?.term.clear()} disabled={!active}>지우기</button>
      </div>
      <div className="term-host" ref={hostRef} />
      {entries.length === 0 && (
        <div className="term-empty">
          <button className="primary" onClick={newTerminal}>터미널 열기</button>
        </div>
      )}
    </div>
  )
}

/** 셸이 알려준 창 제목을 탭에 맞게 줄인다: 실행 파일 전체 경로면 파일 이름만 */
function shortTitle(raw: string): string {
  let t = raw.trim()
  if (/^[a-z]:[\\/].*\.exe$/i.test(t) || /^\/.*\/[^/]+$/.test(t)) t = t.split(/[\\/]/).pop() ?? t
  t = t.replace(/\.exe$/i, '')
  return t.slice(0, 40)
}
