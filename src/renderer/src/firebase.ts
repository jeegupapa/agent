// Firebase(Auth + Firestore) 연결과 세션 기록 저장/불러오기.
// 렌더러(Chromium)에서 실행되므로 Auth 는 IndexedDB 에 로그인 상태를 유지하고,
// Firestore 는 오프라인 캐시를 켠다.
import { deleteApp, getApps, initializeApp, type FirebaseApp } from 'firebase/app'
import {
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  type Auth,
  type User
} from 'firebase/auth'
import {
  collection,
  connectFirestoreEmulator,
  deleteDoc,
  doc,
  getDoc,
  initializeFirestore,
  limit,
  onSnapshot,
  orderBy,
  persistentLocalCache,
  query,
  setDoc,
  type Firestore
} from 'firebase/firestore'
import type {
  FirebaseSettings,
  FirebaseWebConfig,
  SavedSessionMeta,
  ToolCallRecord,
  UsageSummary
} from '../../shared/types'
import type { ChatItem } from './components/Chat'

export interface FbUser {
  uid: string
  email: string | null
}

export interface SavedSession extends SavedSessionMeta {
  usage: UsageSummary
  items: ChatItem[]
  toolCalls: ToolCallRecord[]
}

/** 도구 결과는 길어질 수 있어 문서 1MB 제한을 넘지 않도록 자른다 */
const MAX_RESULT_CHARS = 6000
const MAX_DOC_BYTES = 900_000

let app: FirebaseApp | null = null
let auth: Auth | null = null
let db: Firestore | null = null
let currentKey = ''

function settingsKey(s: FirebaseSettings): string {
  return JSON.stringify([s.config?.projectId, s.config?.appId, s.config?.apiKey, s.emulator ?? ''])
}

/**
 * 설정으로 Firebase 를 초기화한다. 같은 설정이면 재사용, 다른 설정이면 기존 앱을 내리고 다시 만든다.
 * 설정이 비어 있으면 연결을 끊는다.
 */
export async function ensureFirebase(s: FirebaseSettings): Promise<boolean> {
  const key = settingsKey(s)
  if (!s.config?.apiKey || !s.config.projectId || !s.config.appId) {
    await teardown()
    return false
  }
  if (app && key === currentKey) return true
  await teardown()

  app = initializeApp(s.config as FirebaseWebConfig, 'studio')
  auth = getAuth(app)
  db = initializeFirestore(app, { localCache: persistentLocalCache() })

  if (s.emulator?.trim()) {
    const [authHost, fsHost] = s.emulator.split(',').map((x) => x.trim())
    if (authHost) connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true })
    if (fsHost) {
      const [h, p] = fsHost.split(':')
      connectFirestoreEmulator(db, h, Number(p || 8080))
    }
  }
  currentKey = key
  return true
}

async function teardown(): Promise<void> {
  if (app) {
    try {
      await deleteApp(app)
    } catch {
      /* 이미 내려간 경우 */
    }
  }
  for (const a of getApps()) if (a.name === 'studio') await deleteApp(a).catch(() => undefined)
  app = null
  auth = null
  db = null
  currentKey = ''
}

export function isReady(): boolean {
  return !!(auth && db)
}

export function onAuth(cb: (u: FbUser | null) => void): () => void {
  if (!auth) {
    cb(null)
    return () => undefined
  }
  return onAuthStateChanged(auth, (u: User | null) => cb(u ? { uid: u.uid, email: u.email } : null))
}

export function currentUser(): FbUser | null {
  const u = auth?.currentUser
  return u ? { uid: u.uid, email: u.email } : null
}

export async function signIn(email: string, password: string): Promise<FbUser> {
  if (!auth) throw new Error('Firebase 가 초기화되지 않았습니다. 설정을 먼저 저장하세요.')
  const cred = await signInWithEmailAndPassword(auth, email, password)
  return { uid: cred.user.uid, email: cred.user.email }
}

export async function register(email: string, password: string): Promise<FbUser> {
  if (!auth) throw new Error('Firebase 가 초기화되지 않았습니다. 설정을 먼저 저장하세요.')
  const cred = await createUserWithEmailAndPassword(auth, email, password)
  return { uid: cred.user.uid, email: cred.user.email }
}

export async function signOut(): Promise<void> {
  if (auth) await fbSignOut(auth)
}

/** Firebase Auth 오류 코드를 한국어 문장으로 */
export function authErrorText(err: unknown): string {
  const code = (err as { code?: string })?.code ?? ''
  const map: Record<string, string> = {
    'auth/invalid-email': '이메일 형식이 올바르지 않습니다.',
    'auth/user-not-found': '등록되지 않은 이메일입니다. "계정 만들기"를 누르세요.',
    'auth/wrong-password': '비밀번호가 틀렸습니다.',
    'auth/invalid-credential': '이메일 또는 비밀번호가 틀렸습니다.',
    'auth/email-already-in-use': '이미 가입된 이메일입니다. "로그인"을 누르세요.',
    'auth/weak-password': '비밀번호는 6자 이상이어야 합니다.',
    'auth/operation-not-allowed': 'Firebase 콘솔 > Authentication 에서 이메일/비밀번호 로그인을 켜야 합니다.',
    'auth/network-request-failed': '네트워크 오류입니다. 인터넷 연결과 firebaseConfig 를 확인하세요.',
    'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'apiKey 가 올바르지 않습니다.',
    'auth/too-many-requests': '시도가 너무 많습니다. 잠시 후 다시 시도하세요.'
  }
  return map[code] ?? (err instanceof Error ? err.message : String(err))
}

// ---------- 세션 기록 ----------

function sessionsCol(uid: string) {
  if (!db) throw new Error('Firestore 가 초기화되지 않았습니다.')
  return collection(db, 'users', uid, 'sessions')
}

/** undefined 제거 + 결과 문자열 자르기 (Firestore 는 undefined 를 거부한다) */
function sanitize(s: SavedSession): SavedSession {
  const toolCalls = s.toolCalls.map((c) => ({
    ...c,
    // 전체 파일 스냅샷은 크기가 커서 저장하지 않는다 (입력의 old/new 로 변경 부분 diff 는 남는다)
    fileBefore: undefined,
    fileAfter: undefined,
    result:
      c.result && c.result.length > MAX_RESULT_CHARS
        ? c.result.slice(0, MAX_RESULT_CHARS) + `\n… (${c.result.length - MAX_RESULT_CHARS}자 생략)`
        : c.result
  }))
  let out: SavedSession = JSON.parse(JSON.stringify({ ...s, toolCalls }))
  // 그래도 너무 크면 도구 결과를 통째로 빼고, 그래도 크면 입력도 요약한다
  if (JSON.stringify(out).length > MAX_DOC_BYTES) {
    out = { ...out, toolCalls: out.toolCalls.map((c) => ({ ...c, result: '(용량 초과로 생략)' })) }
  }
  if (JSON.stringify(out).length > MAX_DOC_BYTES) {
    out = { ...out, toolCalls: out.toolCalls.map((c) => ({ ...c, input: {} })) }
  }
  return out
}

export async function saveSession(uid: string, s: SavedSession): Promise<void> {
  await setDoc(doc(sessionsCol(uid), s.id), sanitize(s), { merge: true })
}

export async function loadSession(uid: string, id: string): Promise<SavedSession | null> {
  const snap = await getDoc(doc(sessionsCol(uid), id))
  return snap.exists() ? (snap.data() as SavedSession) : null
}

export async function deleteSession(uid: string, id: string): Promise<void> {
  await deleteDoc(doc(sessionsCol(uid), id))
}

/** 최근 세션 목록을 실시간으로 구독한다 (메타데이터만 사용) */
export function subscribeSessions(
  uid: string,
  cb: (list: SavedSessionMeta[]) => void,
  onError?: (e: Error) => void,
  max = 40
): () => void {
  const q = query(sessionsCol(uid), orderBy('updatedAt', 'desc'), limit(max))
  return onSnapshot(
    q,
    (snap) =>
      cb(
        snap.docs.map((d) => {
          const x = d.data() as SavedSession
          return {
            id: d.id,
            title: x.title,
            cwd: x.cwd,
            model: x.model,
            createdAt: x.createdAt,
            updatedAt: x.updatedAt,
            numTurns: x.numTurns ?? x.usage?.numTurns ?? 0,
            host: x.host ?? ''
          }
        })
      ),
    (e) => onError?.(e)
  )
}

/**
 * 콘솔에서 복사한 firebaseConfig 텍스트를 관대하게 파싱한다.
 * `const firebaseConfig = { apiKey: "..", ... };` 처럼 JS 객체 리터럴도 받는다.
 */
export function parseFirebaseConfig(text: string): FirebaseWebConfig {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < 0) throw new Error('{ ... } 형태의 설정을 붙여넣으세요.')
  let body = text.slice(start, end + 1)
  body = body
    .replace(/\/\/.*$/gm, '')
    .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
    .replace(/'/g, '"')
    .replace(/,\s*}/g, '}')
  const obj = JSON.parse(body) as Record<string, unknown>
  const need = ['apiKey', 'authDomain', 'projectId', 'appId']
  for (const k of need) if (typeof obj[k] !== 'string' || !obj[k]) throw new Error(`${k} 가 없습니다.`)
  return {
    apiKey: obj.apiKey as string,
    authDomain: obj.authDomain as string,
    projectId: obj.projectId as string,
    storageBucket: typeof obj.storageBucket === 'string' ? obj.storageBucket : undefined,
    messagingSenderId: typeof obj.messagingSenderId === 'string' ? obj.messagingSenderId : undefined,
    appId: obj.appId as string
  }
}
