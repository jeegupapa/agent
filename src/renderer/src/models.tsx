// 모델 선택 UI. 목록은 메인 프로세스가 SDK 에서 받아 온 것을 쓰고, 바뀌면 모든 선택 상자가 함께 갱신된다
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  isAutoSpec,
  modelName,
  modelOptions,
  modelShort,
  resolveModelSpec,
  type ModelCatalog
} from '../../shared/models'

let catalog: ModelCatalog | null = null
let started = false
const listeners = new Set<() => void>()

function start(): void {
  if (started) return
  started = true
  const set = (c: ModelCatalog | null): void => {
    if (!c) return
    catalog = c
    listeners.forEach((l) => l())
  }
  void window.api.getModels().then(set)
  window.api.onModelsChanged(set)
}

/** 사용 가능한 모델 목록 (아직 못 받았으면 null) */
export function useModelCatalog(): ModelCatalog | null {
  return useSyncExternalStore(
    (cb) => {
      start()
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => catalog
  )
}

/** 목록·배지에 쓰는 짧은 이름 ('Fable 5.2 · 자동', 'Opus 5.5', '기본') */
export function useModelShort(spec: string | undefined): string {
  return modelShort(spec, useModelCatalog())
}

export function ModelSelect(p: {
  value: string | undefined
  onChange: (value: string | undefined) => void
  /** 값이 비었을 때의 이름 ('CLI 기본값', '기본 모델 (사이드바 설정값)') */
  emptyLabel: string
  /** 빈 값을 맨 위에 둘지 (직원 설정처럼 "따라가기"가 기본인 곳) */
  emptyFirst?: boolean
  className?: string
  disabled?: boolean
}) {
  const cat = useModelCatalog()
  const { auto, pinned } = modelOptions(cat)
  const value = p.value ?? ''
  const known = value === '' || auto.some((o) => o.value === value) || pinned.some((o) => o.value === value)
  const empty = <option value="">{p.emptyLabel}</option>
  return (
    <select className={p.className ?? 'text'} value={value} disabled={p.disabled} onChange={(e) => p.onChange(e.target.value || undefined)}>
      {p.emptyFirst && empty}
      <optgroup label="자동 (새 버전이 나오면 따라감)">
        {auto.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </optgroup>
      {!p.emptyFirst && empty}
      {(pinned.length > 0 || !known) && (
        <optgroup label="버전 고정">
          {!known && <option value={value}>{modelName(value)}</option>}
          {pinned.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </optgroup>
      )}
    </select>
  )
}

const SEEN_KEY = 'claude-cli-studio.model-seen'

function loadSeen(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

/**
 * 자동 선택이 가리키는 모델이 지난번과 달라졌는지. 달라졌으면 { from, to } 를 돌려주고,
 * dismiss 를 부르면 지금 모델을 "본 것"으로 기록한다.
 */
export function useModelUpgrade(spec: string | undefined): { now?: string; from?: string; dismiss: () => void } {
  const cat = useModelCatalog()
  const now = isAutoSpec(spec) && cat ? resolveModelSpec(spec, cat) : undefined
  const [seen, setSeen] = useState(loadSeen)
  const key = spec ?? ''
  const remember = (): void => {
    if (!now) return
    const next = { ...loadSeen(), [key]: now }
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(next))
    } catch {
      /* 무시 */
    }
    setSeen(next)
  }
  // 처음 보는 선택값이면 조용히 기록만 한다
  useEffect(() => {
    if (now && !seen[key]) remember()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now, key])
  const from = now && seen[key] && seen[key] !== now ? seen[key] : undefined
  return { now, from, dismiss: remember }
}
