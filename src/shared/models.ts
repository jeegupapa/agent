// 모델 선택 규칙. 선택값(spec)은 세 종류다:
//   ''              CLI 기본값 (CLI 와 ~/.claude 설정이 정하는 모델)
//   'auto'          계정의 권장 모델 계열에서 가장 새 버전
//   'auto:<계열>'    그 계열(fable/opus/sonnet/haiku)에서 가장 새 버전
//   그 밖            버전을 고정한 모델 id (예: claude-opus-5-5)
// 자동 선택은 SDK 가 알려 주는 사용 가능 모델 목록(ModelCatalog)에서 실행 직전에 실제 id 로 바뀐다.
// 그래서 새 모델이 목록에 올라오면 앱을 고치지 않아도 다음 요청부터 적용된다.

export interface ModelRow {
  /** SDK 에 넘길 수 있는 값. 별칭('opus')이거나 전체 id */
  value: string
  /** 별칭이 가리키는 실제 모델 id */
  resolved?: string
  name: string
  description?: string
}

export interface ModelCatalog {
  rows: ModelRow[]
  fetchedAt: number
}

export const AUTO = 'auto'
/** 표시 순서 */
export const FAMILIES = ['fable', 'opus', 'sonnet', 'haiku'] as const

export interface ParsedModel {
  family: string
  major: number
  minor: number
}

/** claude-<계열>-<major>[-<minor>][-<날짜>] 형식만 해석한다 (예: claude-haiku-4-5-20251001 → haiku 4.5) */
export function parseModelId(id: string | undefined): ParsedModel | null {
  if (!id) return null
  const bare = id.trim().split('[')[0]
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(bare)
  if (!m) return null
  return { family: m[1], major: Number(m[2]), minor: m[3] ? Number(m[3]) : 0 }
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function versionOf(p: ParsedModel): string {
  return `${p.major}${p.minor ? `.${p.minor}` : ''}`
}

/** 'claude-fable-5-2' → 'Fable 5.2' */
export function modelName(id: string): string {
  const p = parseModelId(id)
  if (!p) return id.replace(/^claude-/, '')
  return `${cap(p.family)} ${versionOf(p)}`
}

/** 목록에 있는 모델 id (별칭은 실제 id 로 풀고, 해석할 수 없는 것은 뺀다). 계열 순, 그 안에서는 새 버전 먼저 */
export function catalogIds(catalog: ModelCatalog | null): string[] {
  if (!catalog) return []
  const seen = new Map<string, ParsedModel>()
  for (const r of catalog.rows) {
    const id = r.resolved || r.value
    const p = parseModelId(id)
    if (p && !seen.has(id)) seen.set(id, p)
  }
  const order = (f: string): number => {
    const i = (FAMILIES as readonly string[]).indexOf(f)
    return i < 0 ? FAMILIES.length : i
  }
  return [...seen.entries()]
    .sort(
      ([, a], [, b]) =>
        order(a.family) - order(b.family) || a.family.localeCompare(b.family) || b.major - a.major || b.minor - a.minor
    )
    .map(([id]) => id)
}

/** 그 계열에서 가장 새 버전의 모델 id */
export function newestOf(family: string, catalog: ModelCatalog | null): string | undefined {
  return catalogIds(catalog).find((id) => parseModelId(id)?.family === family)
}

/** 계정의 권장(기본) 모델이 속한 계열 */
export function recommendedFamily(catalog: ModelCatalog | null): string | undefined {
  const row = catalog?.rows.find((r) => r.value === 'default')
  return parseModelId(row?.resolved)?.family
}

export function isAutoSpec(spec: string | undefined): boolean {
  return spec === AUTO || !!spec?.startsWith(`${AUTO}:`)
}

/**
 * 선택값을 SDK 에 넘길 모델로 바꾼다. undefined 면 CLI 기본 모델.
 * 목록을 아직 못 받았으면 계열 자동은 CLI 별칭('fable' 등)으로, 권장 자동은 CLI 기본으로 떨어진다.
 */
export function resolveModelSpec(spec: string | undefined, catalog: ModelCatalog | null): string | undefined {
  const s = spec?.trim()
  if (!s) return undefined
  if (s === AUTO) {
    const fam = recommendedFamily(catalog)
    return fam ? newestOf(fam, catalog) : undefined
  }
  if (s.startsWith(`${AUTO}:`)) {
    const fam = s.slice(AUTO.length + 1)
    return newestOf(fam, catalog) ?? fam
  }
  return s
}

/** 이전 버전이 목록에 고정해 두었던 모델 id → 같은 계열의 자동 선택 */
const LEGACY_PINNED = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']
export function legacyToAuto(model: string | undefined): string | undefined {
  if (!model || !LEGACY_PINNED.includes(model)) return undefined
  return `${AUTO}:${parseModelId(model)!.family}`
}

export interface ModelOption {
  value: string
  label: string
}

/** 모델 선택 상자에 넣을 항목. 자동 선택 / 버전 고정 두 묶음 */
export function modelOptions(catalog: ModelCatalog | null): { auto: ModelOption[]; pinned: ModelOption[] } {
  const ids = catalogIds(catalog)
  const families = catalog ? [...new Set(ids.map((id) => parseModelId(id)!.family))] : [...FAMILIES]
  const rec = resolveModelSpec(AUTO, catalog)
  const auto: ModelOption[] = [{ value: AUTO, label: rec ? `자동 · 권장 모델 최신 (지금 ${modelName(rec)})` : '자동 · 권장 모델 최신' }]
  for (const f of families) {
    const newest = newestOf(f, catalog)
    auto.push({
      value: `${AUTO}:${f}`,
      label: newest ? `${cap(f)} 최신 (지금 ${versionOf(parseModelId(newest)!)})` : `${cap(f)} 최신`
    })
  }
  return { auto, pinned: ids.map((id) => ({ value: id, label: modelName(id) })) }
}

/** 목록·배지에 쓰는 짧은 이름 */
export function modelShort(spec: string | undefined, catalog: ModelCatalog | null): string {
  if (!spec) return '기본'
  if (!isAutoSpec(spec)) return modelName(spec)
  const id = resolveModelSpec(spec, catalog)
  if (parseModelId(id)) return `${modelName(id!)} · 자동`
  return spec === AUTO ? '자동' : `${cap(spec.slice(AUTO.length + 1))} 최신`
}
