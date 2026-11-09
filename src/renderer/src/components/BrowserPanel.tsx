import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Attachment } from '../../../shared/types'

/**
 * 오른쪽 패널의 내장 브라우저 (<webview>).
 * 주소창·뒤로/앞으로/새로고침, 현재 페이지를 채팅에 첨부(스크린샷)하거나 본문 텍스트·링크를 입력창에 넣는다.
 * 로그인 상태(쿠키)는 persist:browser 파티션에 남아 앱을 다시 켜도 유지된다.
 */

const KEY_URL = 'claude-cli-studio.browser.url'
const HOME = 'https://www.google.com/'

/** 주소창 입력 → URL. 도메인처럼 보이지 않으면 Google 검색 */
export function toUrl(input: string): string {
  const s = input.trim()
  if (!s) return HOME
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^about:/i.test(s)) return s
  if (/^localhost(:\d+)?([/?#]|$)/i.test(s) || /^(\d{1,3}\.){3}\d{1,3}(:\d+)?([/?#]|$)/.test(s)) return `http://${s}`
  if (!/\s/.test(s) && /^[\w-]+(\.[\w-]+)+(:\d+)?([/?#]|$)/.test(s)) return `https://${s}`
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`
}

interface Props {
  /** 페이지 스크린샷을 채팅 첨부로 */
  onAttach: (atts: Attachment[]) => void
  /** 링크·본문 텍스트를 채팅 입력창에 */
  onInsertText: (text: string) => void
}

export function BrowserPanel(p: Props) {
  const viewRef = useRef<Electron.WebviewTag | null>(null)
  // src 속성은 처음 한 번만 준다. 이후 이동은 loadURL 로 (상태가 바뀔 때마다 src 를 다시 쓰면 페이지가 다시 로드된다)
  const initialUrl = useRef(localStorage.getItem(KEY_URL) ?? HOME)
  const [input, setInput] = useState(() => localStorage.getItem(KEY_URL) ?? HOME)
  const [url, setUrl] = useState(() => localStorage.getItem(KEY_URL) ?? HOME)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(false)
  const [canBack, setCanBack] = useState(false)
  const [canFwd, setCanFwd] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  useEffect(() => {
    const v = viewRef.current
    if (!v) return
    const sync = (): void => {
      try {
        const u = v.getURL()
        if (u) {
          setUrl(u)
          setInput(u)
          localStorage.setItem(KEY_URL, u)
        }
        setCanBack(v.canGoBack())
        setCanFwd(v.canGoForward())
      } catch {
        /* 아직 준비 안 됨 */
      }
    }
    const onStart = (): void => { setLoading(true); setError(null) }
    const onStop = (): void => { setLoading(false); sync() }
    const onTitle = (e: Electron.PageTitleUpdatedEvent): void => setTitle(e.title)
    const onFail = (e: Electron.DidFailLoadEvent): void => {
      if (e.errorCode === -3 || !e.isMainFrame) return // 사용자가 중단
      setLoading(false)
      setError(`${e.errorDescription || '페이지를 불러오지 못했습니다'} (${e.errorCode})`)
    }
    v.addEventListener('did-start-loading', onStart)
    v.addEventListener('did-stop-loading', onStop)
    v.addEventListener('did-navigate', sync)
    v.addEventListener('did-navigate-in-page', sync)
    v.addEventListener('page-title-updated', onTitle)
    v.addEventListener('did-fail-load', onFail)
    return () => {
      v.removeEventListener('did-start-loading', onStart)
      v.removeEventListener('did-stop-loading', onStop)
      v.removeEventListener('did-navigate', sync)
      v.removeEventListener('did-navigate-in-page', sync)
      v.removeEventListener('page-title-updated', onTitle)
      v.removeEventListener('did-fail-load', onFail)
    }
  }, [])

  const go = (raw: string): void => {
    const target = toUrl(raw)
    setError(null)
    setInput(target)
    try {
      void viewRef.current?.loadURL(target)
    } catch {
      setUrl(target)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') go(input)
    if (e.key === 'Escape') setInput(url)
  }
  const showFlash = (msg: string): void => {
    setFlash(msg)
    window.setTimeout(() => setFlash(null), 2500)
  }

  const attachScreenshot = async (): Promise<void> => {
    const v = viewRef.current
    if (!v) return
    setBusy('shot')
    try {
      const img = await v.capturePage()
      // 렌더러에는 Node Buffer 가 없어 toPNG().toString('base64') 는 쓸 수 없다
      const base64 = img.toDataURL().split(',')[1] ?? ''
      if (!base64) throw new Error('빈 화면입니다')
      const att = await window.api.saveClipboardImage({ base64, mime: 'image/png' })
      p.onAttach([{ ...att, name: `브라우저 ${safeName(title || url)}.png` }])
      showFlash('스크린샷을 채팅에 첨부했습니다')
    } catch (e) {
      setError(`스크린샷 실패: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  const insertText = async (): Promise<void> => {
    const v = viewRef.current
    if (!v) return
    setBusy('text')
    try {
      const raw = (await v.executeJavaScript(
        '(() => { const el = document.querySelector("article, main") || document.body; return (el.innerText || "").replace(/\\n{3,}/g, "\\n\\n").trim() })()',
        true
      )) as string
      const LIMIT = 6000
      const body = raw.length > LIMIT ? raw.slice(0, LIMIT) + `\n… (${raw.length - LIMIT}자 생략)` : raw
      const head = `> 참조: ${title || url}\n> ${url}`
      p.onInsertText(`${head}\n\n${body.split('\n').map((l) => '> ' + l).join('\n')}`)
      showFlash('페이지 본문을 입력창에 넣었습니다')
    } catch (e) {
      setError(`본문을 읽지 못했습니다: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(null)
    }
  }
  const insertLink = (): void => {
    p.onInsertText(title ? `[${title}](${url})` : url)
    showFlash('링크를 입력창에 넣었습니다')
  }

  return (
    <div className="browser-panel">
      <div className="browser-bar">
        <button className="pbtn icon" title="뒤로" disabled={!canBack} onClick={() => viewRef.current?.goBack()}>◀</button>
        <button className="pbtn icon" title="앞으로" disabled={!canFwd} onClick={() => viewRef.current?.goForward()}>▶</button>
        <button className="pbtn icon" title={loading ? '중지' : '새로고침'} onClick={() => (loading ? viewRef.current?.stop() : viewRef.current?.reload())}>
          {loading ? '✕' : '⟳'}
        </button>
        <input
          className="text browser-url"
          value={input}
          spellCheck={false}
          placeholder="주소 또는 검색어"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          onFocus={(e) => e.currentTarget.select()}
        />
        <button className="pbtn icon" title="기본 브라우저에서 열기" onClick={() => window.open(url)}>↗</button>
      </div>
      <div className="browser-actions">
        <button className="pbtn" title="현재 화면을 PNG 로 저장해 채팅에 첨부" disabled={busy !== null} onClick={() => void attachScreenshot()}>
          📷 스크린샷 → 채팅
        </button>
        <button className="pbtn" title="페이지 본문 텍스트를 참조 블록으로 입력창에 넣기" disabled={busy !== null} onClick={() => void insertText()}>
          📄 본문 → 채팅
        </button>
        <button className="pbtn" title="현재 주소를 입력창에 넣기" onClick={insertLink}>🔗 링크 → 채팅</button>
        {flash && <span className="browser-flash">{flash}</span>}
      </div>
      {error && <div className="notice error browser-error">{error}</div>}
      <webview
        ref={viewRef as unknown as React.Ref<HTMLElement>}
        className="browser-view"
        src={initialUrl.current}
        partition="persist:browser"
        {...({ allowpopups: 'true' } as object)}
      />
    </div>
  )
}

function safeName(s: string): string {
  return s.replace(/^https?:\/\//, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 40) || 'page'
}
