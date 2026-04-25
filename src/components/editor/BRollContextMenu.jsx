import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

/**
 * Lightweight context menu rendered via portal.
 *
 * @param {number} x,y - viewport coordinates where the menu opens (from event.clientX/Y)
 * @param {Array<{ label, shortcut?, onClick, disabled?, divider? }>} items
 * @param {() => void} onClose
 */
export default function BRollContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null)

  useEffect(() => {
    const onDocMouseDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const onEsc = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onEsc)
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown)
      document.removeEventListener('keydown', onEsc)
    }
  }, [onClose])

  // Clamp menu within viewport
  const menuW = 180
  const menuH = items.length * 28 + 16
  const clampedX = Math.min(x, window.innerWidth - menuW - 8)
  const clampedY = Math.min(y, window.innerHeight - menuH - 8)

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[300] rounded-lg border border-white/10 bg-[#1a1a1c] shadow-2xl shadow-black/60 py-1 text-xs"
      style={{ left: clampedX, top: clampedY, minWidth: menuW }}
    >
      {items.map((it, i) => {
        if (it.divider) return <div key={`d-${i}`} className="my-1 h-px bg-white/5" />
        return (
          <button
            key={i}
            disabled={it.disabled}
            onClick={() => { if (!it.disabled) { onClose(); it.onClick() } }}
            className="w-full flex items-center justify-between px-3 py-1.5 text-left text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 disabled:text-zinc-600 disabled:cursor-not-allowed disabled:hover:bg-transparent"
          >
            <span>{it.label}</span>
            {it.shortcut && <span className="text-[10px] text-zinc-500">{it.shortcut}</span>}
          </button>
        )
      })}
    </div>,
    document.body,
  )
}
