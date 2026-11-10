// 사용 가능한 모델 목록을 보관한다. 목록은 SDK(supportedModels) 가 알려 주며, 요청이 정상적으로 끝날 때마다
// 그 세션이 받은 목록으로 바뀐다. 파일에 저장해 두어 다음 실행 때 바로 쓸 수 있다.
//
// 목록만 받으려고 CLI 를 따로 띄우지 않는다. 띄운 직후에 끄면 그 사이 진행 중이던 로그인 토큰 갱신이 끊겨
// CLI 로그인이 풀릴 수 있기 때문이다.
import { readFileSync, writeFileSync } from 'fs'
import { resolveModelSpec, type ModelCatalog, type ModelRow } from '../shared/models'

/** SDK 의 ModelInfo 에서 쓰는 필드만 */
export interface SdkModelInfo {
  value: string
  resolvedModel?: string
  displayName: string
  description?: string
}

class ModelCatalogStore {
  private catalog: ModelCatalog | null = null
  private file: string | null = null
  private onChange: ((c: ModelCatalog) => void) | null = null

  init(opts: { file: string; onChange: (c: ModelCatalog) => void }): void {
    this.file = opts.file
    this.onChange = opts.onChange
    try {
      const saved = JSON.parse(readFileSync(opts.file, 'utf8')) as ModelCatalog
      if (Array.isArray(saved.rows) && saved.rows.length) this.catalog = saved
    } catch {
      /* 아직 저장된 목록이 없다 */
    }
  }

  get(): ModelCatalog | null {
    return this.catalog
  }

  /** SDK 가 준 목록을 반영한다. 내용이 바뀌었을 때만 화면에 알린다 */
  update(models: SdkModelInfo[]): void {
    if (!Array.isArray(models) || models.length === 0) return
    const rows: ModelRow[] = models.map((m) => ({
      value: m.value,
      resolved: m.resolvedModel,
      name: m.displayName,
      description: m.description
    }))
    const changed = JSON.stringify(rows) !== JSON.stringify(this.catalog?.rows)
    this.catalog = { rows, fetchedAt: Date.now() }
    try {
      if (this.file) writeFileSync(this.file, JSON.stringify(this.catalog))
    } catch {
      /* 저장 실패는 무시 (다음에 다시 받는다) */
    }
    if (changed) this.onChange?.(this.catalog)
  }

  /** 선택값('auto', 'auto:fable', 고정 id, 빈 값)을 SDK 에 넘길 모델로. undefined 면 CLI 기본 모델 */
  resolve(spec: string | undefined): string | undefined {
    return resolveModelSpec(spec, this.catalog)
  }
}

export const modelCatalog = new ModelCatalogStore()
