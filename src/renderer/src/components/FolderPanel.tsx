import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { Attachment, FsEntry, FsRead } from '../../../shared/types'

/**
 * 오른쪽 패널의 폴더 탭: 작업 폴더의 파일 트리와 미리보기.
 * 파일은 채팅에 첨부하거나 경로를 입력창에 넣을 수 있고, 탐색기에서 열 수도 있다.
 */

interface Props {
  cwd: string
  /** 도구 호출 수 등, 바뀌면 열려 있는 폴더를 다시 읽는다 */
  refreshKey: number
  onPickFolder: () => void
  onAttach: (atts: Attachment[]) => void
  onInsertText: (text: string) => void
}

const ICONS: Record<string, string> = {
  ts: '🟦', tsx: '🟦', js: '🟨', jsx: '🟨', mjs: '🟨', cjs: '🟨', json: '🟫', md: '📝', txt: '📄',
  css: '🎨', scss: '🎨', html: '🌐', py: '🐍', rs: '🦀', go: '🐹', java: '☕', cs: '🟪',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', webp: '🖼️', svg: '🖼️', ico: '🖼️',
  pdf: '📕', zip: '🗜️', exe: '⚙️', dll: '⚙️', yml: '⚙️', yaml: '⚙️', toml: '⚙️', lock: '🔒'
}
function iconFor(e: FsEntry, open: boolean): string {
  if (e.isDir) return open ? '📂' : '📁'
  const ext = e.name.split('.').pop()?.toLowerCase() ?? ''
  return ICONS[ext] ?? '📄'
}
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function mimeFor(name: string): string | undefined {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const m: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', md: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv' }
  return m[ext]
}

export function FolderPanel(p: Props) {
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<FsEntry | null>(null)
  const [content, setContent] = useState<FsRead | null>(null)
  const [filter, setFilter] = useState('')
  const [loadingRoot, setLoadingRoot] = useState(false)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const load = useCallback(async (dir: string): Promise<void> => {
    const list = await window.api.fsList(dir)
    setChildren((prev) => ({ ...prev, [dir]: list }))
  }, [])

  // 작업 폴더가 바뀌면 트리를 처음부터
  useEffect(() => {
    setChildren({})
    setExpanded(new Set())
    setSelected(null)
    setContent(null)
    if (!p.cwd) return
    setLoadingRoot(true)
    void load(p.cwd).finally(() => setLoadingRoot(false))
  }, [p.cwd, load])

  // 도구 호출이 늘어나면(파일이 바뀌었을 수 있음) 열려 있는 폴더를 다시 읽는다
  const firstKey = useRef(true)
  useEffect(() => {
    if (firstKey.current) {
      firstKey.current = false
      return
    }
    const t = setTimeout(() => void refreshOpen(), 800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.refreshKey])

  const refreshOpen = async (): Promise<void> => {
    if (!p.cwd) return
    await Promise.all([p.cwd, ...expandedRef.current].map((d) => load(d)))
    if (selected && !selected.isDir) setContent(await window.api.fsRead(selected.path))
  }

  const toggle = (e: FsEntry): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(e.path)) next.delete(e.path)
      else {
        next.add(e.path)
        if (!children[e.path]) void load(e.path)
      }
      return next
    })
  }
  const select = async (e: FsEntry): Promise<void> => {
    setSelected(e)
    if (e.isDir) {
      setContent(null)
      toggle(e)
      return
    }
    setContent(null)
    setContent(await window.api.fsRead(e.path))
  }
  const attach = (e: FsEntry): void => p.onAttach([{ name: e.name, path: e.path, size: e.size, mime: mimeFor(e.name) }])
  const insertPath = (e: FsEntry): void => p.onInsertText(e.path.includes(' ') ? `"${e.path}"` : e.path)

  const q = filter.trim().toLowerCase()
  const renderDir = (dir: string, depth: number): ReactElement[] => {
    const list = children[dir]
    if (!list) return [<li key={`${dir}:loading`} className="fs-row muted" style={{ paddingLeft: 12 + depth * 14 }}>불러오는 중…</li>]
    const rows: ReactElement[] = []
    for (const e of list) {
      if (q && !e.isDir && !e.name.toLowerCase().includes(q)) continue
      const open = expanded.has(e.path)
      rows.push(
        <li
          key={e.path}
          className={`fs-row ${selected?.path === e.path ? 'selected' : ''} ${e.isDir ? 'dir' : 'file'}`}
          style={{ paddingLeft: 12 + depth * 14 }}
          title={e.path}
          onClick={() => void select(e)}
          onDoubleClick={() => (e.isDir ? void window.api.openPath(e.path) : void window.api.openPath(e.path))}
        >
          {e.isDir ? <span className="fs-caret">{open ? '▾' : '▸'}</span> : <span className="fs-caret" />}
          <span className="fs-icon">{iconFor(e, open)}</span>
          <span className="fs-name">{e.name}</span>
          {!e.isDir && e.size !== undefined && <span className="fs-size">{fmtBytes(e.size)}</span>}
          {!e.isDir && (
            <span className="fs-actions">
              <button className="fs-act" title="채팅에 첨부" onClick={(ev) => { ev.stopPropagation(); attach(e) }}>📎</button>
              <button className="fs-act" title="경로를 입력창에 넣기" onClick={(ev) => { ev.stopPropagation(); insertPath(e) }}>↩</button>
            </span>
          )}
        </li>
      )
      if (e.isDir && open) rows.push(...renderDir(e.path, depth + 1))
    }
    if (rows.length === 0) rows.push(<li key={`${dir}:empty`} className="fs-row muted" style={{ paddingLeft: 12 + depth * 14 }}>{q ? '일치하는 파일 없음' : '비어 있음'}</li>)
    return rows
  }

  const rootName = p.cwd ? p.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p.cwd : ''

  return (
    <div className="folder-panel">
      <div className="fs-head">
        <span className="fs-root" title={p.cwd}>📂 {rootName}</span>
        <span className="fs-spacer" />
        <button className="pbtn" title="다른 작업 폴더 선택" onClick={p.onPickFolder}>폴더 선택</button>
        <button className="pbtn" title="탐색기에서 열기" onClick={() => void window.api.openPath(p.cwd)}>탐색기</button>
        <button className="pbtn" title="다시 읽기" onClick={() => void refreshOpen()}>⟳</button>
      </div>
      <div className="fs-filter">
        <input className="text" placeholder="파일 이름 필터 (열린 폴더 안에서)" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <ul className="fs-tree">{p.cwd ? (loadingRoot && !children[p.cwd] ? <li className="fs-row muted">불러오는 중…</li> : renderDir(p.cwd, 0)) : <li className="fs-row muted">작업 폴더가 없습니다</li>}</ul>
      {selected && !selected.isDir && (
        <div className="fs-preview">
          <div className="fs-preview-head">
            <span className="fs-preview-name" title={selected.path}>{iconFor(selected, false)} {selected.name}</span>
            <span className="fs-preview-meta">
              {selected.size !== undefined && fmtBytes(selected.size)}
              {selected.mtime !== undefined && ` · ${fmtTime(selected.mtime)}`}
            </span>
            <span className="fs-spacer" />
            <button className="pbtn" title="채팅에 첨부" onClick={() => attach(selected)}>📎 첨부</button>
            <button className="pbtn" title="경로를 입력창에 넣기" onClick={() => insertPath(selected)}>경로 → 채팅</button>
            <button className="pbtn" title="기본 프로그램으로 열기" onClick={() => void window.api.openPath(selected.path)}>열기</button>
            <button className="pbtn" title="탐색기에서 보기" onClick={() => void window.api.revealPath(selected.path)}>탐색기</button>
            <button className="pbtn" title="미리보기 닫기" onClick={() => { setSelected(null); setContent(null) }}>×</button>
          </div>
          <div className="fs-preview-body">
            {!content && <div className="muted">불러오는 중…</div>}
            {content?.kind === 'text' && (
              <>
                <pre className="fs-text">{content.text}</pre>
                {content.truncated && <div className="muted">… 앞부분 256KB 만 표시합니다 (전체 {fmtBytes(content.size)})</div>}
              </>
            )}
            {content?.kind === 'image' && <img className="fs-image" src={content.dataUrl} alt={selected.name} />}
            {content?.kind === 'binary' && <div className="muted">미리볼 수 없는 파일입니다 ({fmtBytes(content.size)}). 첨부하면 Claude 가 Read 도구로 읽습니다.</div>}
            {content?.kind === 'error' && <div className="notice error">{content.message}</div>}
          </div>
        </div>
      )}
    </div>
  )
}
