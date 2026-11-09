// 패널 너비·표시 여부. localStorage 에 저장해 다음 실행에도 유지한다.

export interface PanelLayout {
  sidebarOpen: boolean
  rightOpen: boolean
  sidebarWidth: number
  rightWidth: number
}

export const DEFAULT_LAYOUT: PanelLayout = {
  sidebarOpen: true,
  rightOpen: true,
  sidebarWidth: 260,
  rightWidth: 420
}

export const LIMITS = {
  sidebar: { min: 200, max: 520 },
  right: { min: 280, max: 1200 },
  /** 가운데 채팅이 이보다 좁아지지 않게 한다 */
  chatMin: 360
}

const KEY = 'claude-cli-studio.layout'

export function loadLayout(): PanelLayout {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_LAYOUT
    const parsed = JSON.parse(raw) as Partial<PanelLayout>
    return {
      sidebarOpen: parsed.sidebarOpen ?? DEFAULT_LAYOUT.sidebarOpen,
      rightOpen: parsed.rightOpen ?? DEFAULT_LAYOUT.rightOpen,
      sidebarWidth: clamp(parsed.sidebarWidth ?? DEFAULT_LAYOUT.sidebarWidth, LIMITS.sidebar.min, LIMITS.sidebar.max),
      rightWidth: clamp(parsed.rightWidth ?? DEFAULT_LAYOUT.rightWidth, LIMITS.right.min, LIMITS.right.max)
    }
  } catch {
    return DEFAULT_LAYOUT
  }
}

export function saveLayout(layout: PanelLayout): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout))
  } catch {
    /* 저장 불가 환경이면 무시 */
  }
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** 창 너비를 고려한 사이드바 최대 너비 */
export function maxSidebarWidth(layout: PanelLayout, windowWidth: number): number {
  const rightUsed = layout.rightOpen ? layout.rightWidth : 0
  return Math.max(LIMITS.sidebar.min, Math.min(LIMITS.sidebar.max, windowWidth - rightUsed - LIMITS.chatMin))
}

/** 창 너비를 고려한 오른쪽 패널 최대 너비 */
export function maxRightWidth(layout: PanelLayout, windowWidth: number): number {
  const sidebarUsed = layout.sidebarOpen ? layout.sidebarWidth : 0
  return Math.max(LIMITS.right.min, Math.min(LIMITS.right.max, windowWidth - sidebarUsed - LIMITS.chatMin))
}
