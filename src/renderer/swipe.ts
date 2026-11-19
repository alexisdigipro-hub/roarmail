// Swipe between tabs and pages (Alex, 19 Nov 2026: "wherever the app has pages or tabs, slide left and right").
// One hook for every place with tabs: a two-finger sideways swipe on the trackpad (wheel events, added up, one gesture
// is one step, the momentum after it is swallowed) or a finger on a touch screen moves to the next or previous one.
// It never takes a sideways scroll from something that scrolls sideways, never works inside a text field or an
// editor, and never on the message list's rows (they have their own swipe actions). Regions can sit inside each
// other: the inner one moves first, and at its last tab the swipe goes on to the outer one.
import { useEffect, useRef, useState } from 'react'

export type SlideDir = 'next' | 'prev' | undefined

/** events a region has already used, so the region around it leaves them alone */
const used = new WeakSet<Event>()
const STEP = 70 // px of sideways travel for one step
const QUIET = 240 // ms without sideways events that ends a gesture

const NO_SWIPE = 'input, textarea, select, iframe, .rows, .swipe, .pop, [data-no-swipe]'

/** is there something between the target and the region that should keep this sideways move for itself? */
function kept(target: EventTarget | null, root: HTMLElement, dir: number): boolean {
  let el = target instanceof Element ? target : null
  while (el && el !== root) {
    if (el.matches(NO_SWIPE) || (el instanceof HTMLElement && el.isContentEditable)) return true
    if (el.scrollWidth > el.clientWidth + 1) {
      const ox = getComputedStyle(el).overflowX
      if (ox === 'auto' || ox === 'scroll') {
        // it can still scroll that way: the scroll is its own
        if (dir > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : dir < 0 ? el.scrollLeft > 0 : true) return true
      }
    }
    el = el.parentElement
  }
  return false
}

/**
 * Swipe through `keys` (in their order on screen); `current` is the one shown, `go` shows another.
 * Returns `ref` for the region that listens (a callback ref) and `dir`, the side the last change came from
 * ('next' or 'prev', for clicks too), to put on the new content as data-slide so it slides in from that side.
 */
export function useSwipeTabs<K>(keys: readonly K[], current: K, go: (k: K) => void) {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const live = useRef({ keys, current, go })
  live.current = { keys, current, go }

  // the side of the last change, worked out while drawing so the new content starts its slide on the right side
  const last = useRef(current)
  const dir = useRef<SlideDir>(undefined)
  if (!Object.is(last.current, current)) {
    const a = keys.indexOf(last.current), b = keys.indexOf(current)
    dir.current = a >= 0 && b >= 0 && b < a ? 'prev' : 'next'
    last.current = current
  }

  useEffect(() => {
    if (!el) return undefined
    const st = { acc: 0, last: 0, lock: 0, lockEnd: 0, x: 0, y: 0, t: 0, touch: false }
    /** the key one step that way, or undefined at the end (the region around may take it then) */
    const target = (step: number) => {
      const { keys: ks, current: cur } = live.current
      if (ks.length < 2) return undefined
      const i = ks.indexOf(cur)
      const j = i < 0 ? (step > 0 ? 0 : ks.length - 1) : i + step
      return j >= 0 && j < ks.length && j !== i ? { k: ks[j] } : undefined
    }

    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || used.has(e)) return
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
      const dx = e.deltaX * k, dy = e.deltaY * k
      const now = performance.now()
      const across = Math.abs(dx) > Math.abs(dy) * 1.3 && Math.abs(dx) >= 1
      // just moved: the rest of the same gesture (the trackpad's momentum) is swallowed
      if (now < st.lock) {
        if (across) { st.lock = Math.min(now + QUIET, st.lockEnd); used.add(e) }
        return
      }
      if (!across) { if (Math.abs(dy) > Math.abs(dx)) st.acc = 0; return }
      const step = dx > 0 ? 1 : -1
      const to = target(step)
      if (!to || kept(e.target, el, step)) return
      used.add(e)
      if (now - st.last > QUIET || Math.sign(st.acc) !== step) st.acc = 0
      st.last = now
      st.acc += dx
      if (Math.abs(st.acc) >= STEP) {
        st.acc = 0
        st.lock = now + 420
        st.lockEnd = now + 1500
        live.current.go(to.k)
      }
    }

    const start = (e: TouchEvent) => {
      st.touch = false
      if (e.touches.length !== 1 || used.has(e)) return
      const p = e.touches[0]
      st.x = p.clientX; st.y = p.clientY; st.t = performance.now(); st.touch = true
    }
    const end = (e: TouchEvent) => {
      if (!st.touch || used.has(e)) return
      st.touch = false
      const p = e.changedTouches[0]
      if (!p) return
      const dx = st.x - p.clientX, dy = st.y - p.clientY
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.6 || performance.now() - st.t > 800) return
      const step = dx > 0 ? 1 : -1
      const to = target(step)
      if (!to || kept(e.target, el, step)) return
      used.add(e)
      live.current.go(to.k)
    }

    el.addEventListener('wheel', wheel, { passive: true })
    el.addEventListener('touchstart', start, { passive: true })
    el.addEventListener('touchend', end, { passive: true })
    return () => {
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('touchstart', start)
      el.removeEventListener('touchend', end)
    }
  }, [el])

  return { ref: setEl, dir: dir.current }
}
