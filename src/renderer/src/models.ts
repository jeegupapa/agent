// 앱 전체에서 공통으로 쓰는 모델 목록
export const MODELS: { value: string; label: string; short: string }[] = [
  { value: '', label: 'CLI 기본값', short: '기본' },
  { value: 'claude-fable-5-1', label: 'Fable 5.1 (가장 똑똑함)', short: 'Fable 5.1' },
  { value: 'claude-opus-5-5', label: 'Opus 5.5', short: 'Opus 5.5' },
  { value: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (빠름·저렴)', short: 'Sonnet 5.5' },
  { value: 'claude-haiku-5-5', label: 'Haiku 5.5', short: 'Haiku 5.5' }
]

export function modelShort(value?: string): string {
  if (!value) return '기본'
  return MODELS.find((m) => m.value === value)?.short ?? value.replace(/^claude-/, '')
}
