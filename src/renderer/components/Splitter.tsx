import { useCallback, useState, type KeyboardEvent, type PointerEvent } from 'react'

/** the column widths Alex drags (folders and message list); the reader takes the rest */
export interface Widths { folders: number; list: number }
type Col = keyof Widths

export const WIDTHS: Record<Col, { def: number; min: number; max: number }> = {
  folders: { def: 220, min: 170, max: 380 },
  list: { def: 380, min: 290, max: 680 },
}
// the reader never gets narrower than this while dragging
const READER_MIN = 420
const KEY = 'roarmail.widths'

const clamp = (c: Col, v: number) => Math.round(Math.min(WIDTHS[c].max, Math.max(WIDTHS[c].min, v)))

function saved(): Widths {
  const w = { folders: WIDTHS.folders.def, list: WIDTHS.list.def }
  try {
    const s = JSON.parse(localStorage.getItem(KEY) || '{}')
    for (const c of ['folders', 'list'] as Col[]) if (typeof s[c] === 'number') w[c] = clamp(c, s[c])
  } catch { /* nothing saved, or storage off: the defaults */ }
  return w
}

export function useWidths() {
  const [widths, setWidths] = useState<Widths>(saved)
  const set = useCallback((c: Col, v: number) => setWidths((w) => {
    const next = { ...w, [c]: clamp(c, v) }
    try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* kept for this run only */ }
    return next
  }), [])
  return [widths, set] as const
}

/** a handle in the gap after a column: drag it sideways, double-click it for the first width back, or use the arrow keys */
export function Splitter({ col, width, onChange, title }: { col: Col; width: number; onChange: (c: Col, v: number) => void; title: string }) {
  const [active, setActive] = useState(false)

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    const handle = e.currentTarget
    const app = handle.parentElement!
    const reader = app.querySelector<HTMLElement>('.viewer')
    // how far this column may grow before the reader reaches its minimum
    const room = reader ? reader.getBoundingClientRect().width - READER_MIN : Infinity
    const x0 = e.clientX, w0 = width
    handle.setPointerCapture(e.pointerId)
    setActive(true)
    document.documentElement.classList.add('resizing')
    const move = (ev: globalThis.PointerEvent) => onChange(col, w0 + Math.min(ev.clientX - x0, Math.max(0, room)))
    const up = () => {
      setActive(false)
      document.documentElement.classList.remove('resizing')
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 10
    if (e.key === 'ArrowLeft') { e.preventDefault(); onChange(col, width - step) }
    else if (e.key === 'ArrowRight') { e.preventDefault(); onChange(col, width + step) }
    else if (e.key === 'Enter') { e.preventDefault(); onChange(col, WIDTHS[col].def) }
  }

  return (
    <div className={`splitter no-drag ${active ? 'on' : ''}`} role="separator" aria-orientation="vertical" tabIndex={0}
      aria-valuenow={width} aria-valuemin={WIDTHS[col].min} aria-valuemax={WIDTHS[col].max} title={title}
      onPointerDown={down} onDoubleClick={() => onChange(col, WIDTHS[col].def)} onKeyDown={key} />
  )
}
