// 메모리 저장소. 로그인되어 있으면 Firestore(users/{uid}/memories), 아니면 localStorage.
// 세션을 시작할 때 renderMemory() 로 시스템 프롬프트에 붙인다.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemoryItem } from '../../../shared/types'
import * as fb from '../firebase'

const LOCAL_KEY = 'claude-cli-studio.memory'

function loadLocal(): MemoryItem[] {
  try {
    const raw = localStorage.getItem(LOCAL_KEY)
    if (raw) return JSON.parse(raw) as MemoryItem[]
  } catch {
    /* 무시 */
  }
  return []
}

function saveLocal(list: MemoryItem[]): void {
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(list))
  } catch {
    /* 무시 */
  }
}

/** 경로 비교용 (구분자·대소문자·끝 슬래시 무시) */
export function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export interface MemoryStore {
  memories: MemoryItem[]
  backend: 'firestore' | 'local'
  error?: string
  upsert: (m: MemoryItem) => void
  remove: (id: string) => void
}

export function useMemoryStore(user: fb.FbUser | null, firebaseEnabled: boolean): MemoryStore {
  const useFs = !!user && firebaseEnabled && fb.isReady()
  const [local, setLocal] = useState<MemoryItem[]>(loadLocal)
  const [remote, setRemote] = useState<MemoryItem[]>([])
  const [error, setError] = useState<string | undefined>()
  const migrated = useRef(false)

  useEffect(() => saveLocal(local), [local])

  useEffect(() => {
    if (!useFs || !user) {
      setRemote([])
      return
    }
    setError(undefined)
    return fb.subscribeCollection<MemoryItem>(
      user.uid,
      'memories',
      (list) => setRemote(list.sort((a, b) => b.createdAt - a.createdAt)),
      (e) => setError(e.message)
    )
  }, [useFs, user])

  // 처음 로그인했을 때 로컬에만 있던 메모리를 올린다
  useEffect(() => {
    if (!useFs || !user || migrated.current) return
    if (remote.length === 0 && local.length > 0) {
      migrated.current = true
      const t = setTimeout(() => {
        for (const m of local) void fb.setDocument(user.uid, 'memories', m.id, m)
      }, 1500)
      return () => clearTimeout(t)
    }
    return
  }, [useFs, user, remote, local])

  const upsert = useCallback(
    (m: MemoryItem) => {
      setLocal((l) => {
        const i = l.findIndex((x) => x.id === m.id)
        if (i < 0) return [m, ...l]
        const next = l.slice()
        next[i] = m
        return next
      })
      if (useFs && user) fb.setDocument(user.uid, 'memories', m.id, m).catch((err) => setError(String(err)))
    },
    [useFs, user]
  )
  const remove = useCallback(
    (id: string) => {
      setLocal((l) => l.filter((x) => x.id !== id))
      if (useFs && user) fb.deleteDocument(user.uid, 'memories', id).catch((err) => setError(String(err)))
    },
    [useFs, user]
  )

  return { memories: useFs ? remote : local, backend: useFs ? 'firestore' : 'local', error, upsert, remove }
}

/** 현재 폴더에 적용되는 메모리 (켜진 것만, 전체 + 이 폴더) */
export function activeMemories(memories: MemoryItem[], cwd: string): MemoryItem[] {
  const here = normPath(cwd)
  return memories.filter((m) => m.enabled && (m.scope === 'global' || (m.cwd && normPath(m.cwd) === here)))
}

/**
 * 시스템 프롬프트에 붙일 메모리 텍스트. 없으면 undefined.
 * 오래된 것부터 담되 글자 수 상한을 넘으면 가장 오래된 것부터 뺀다.
 */
export function renderMemory(memories: MemoryItem[], cwd: string, maxChars = 6000): string | undefined {
  const active = activeMemories(memories, cwd).sort((a, b) => a.createdAt - b.createdAt)
  if (active.length === 0) return undefined
  const lines: string[] = []
  let used = 0
  for (const m of active.slice().reverse()) {
    const body = m.text.trim().replace(/\r?\n/g, '\n  ')
    const line = `- ${m.scope === 'global' ? '[모든 폴더]' : '[이 폴더]'} ${body}`
    if (used + line.length > maxChars) break
    lines.push(line)
    used += line.length
  }
  lines.reverse()
  return (
    `# 사용자 메모리\n` +
    `사용자가 Claude CLI Studio 에서 "기억해" 로 저장해 둔 내용입니다. 작업할 때 참고하고 따르되, 현재 대화의 지시와 충돌하면 현재 지시를 우선하세요.\n` +
    lines.join('\n')
  )
}

/** "기억해: …", "/remember …" 같은 입력이면 저장할 본문을 돌려준다 */
export function parseRememberCommand(prompt: string): string | null {
  const m = /^(?:\/remember|\/기억|기억해(?:\s*(?:줘|주세요|라))?)\s*[:：\-]?\s*([\s\S]+)$/.exec(prompt.trim())
  if (!m) return null
  const text = m[1].trim()
  return text.length >= 2 ? text : null
}
