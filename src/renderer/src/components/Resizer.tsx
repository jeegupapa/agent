import { useRef } from 'react'

/**
 * 패널 사이의 세로 드래그 핸들.
 * - 드래그: onResize(delta) 를 픽셀 단위로 호출
 * - 더블클릭: onReset
 */
export function Resizer(p: {
  side: 'left' | 'right'
  onResize: (deltaX: number) => void
  onReset: () => void
  title?: string
}) {
  const startX = useRef(0)
  const lastX = useRef(0)

  return (
    <div
      className={`resizer ${p.side}`}
      title={p.title ?? '드래그해서 너비 조절 · 더블클릭으로 기본 너비'}
      onDoubleClick={p.onReset}
      onPointerDown={(e) => {
        e.preventDefault()
        startX.current = e.clientX
        lastX.current = e.clientX
        const el = e.currentTarget
        el.setPointerCapture(e.pointerId)
        el.classList.add('dragging')
        document.body.classList.add('resizing')
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        const delta = e.clientX - lastX.current
        if (delta !== 0) {
          lastX.current = e.clientX
          p.onResize(delta)
        }
      }}
      onPointerUp={(e) => {
        const el = e.currentTarget
        if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId)
        el.classList.remove('dragging')
        document.body.classList.remove('resizing')
      }}
      onPointerCancel={(e) => {
        e.currentTarget.classList.remove('dragging')
        document.body.classList.remove('resizing')
      }}
    />
  )
}
