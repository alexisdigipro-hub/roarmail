// Rows that leave and rows that arrive (Alex, 1 Nov: "lighter and smoother, and motion where it helps").
// Web Animations on the few rows involved, transform and opacity plus one height, nothing that repaints the list.
// Rests under Settings > Appearance > Motion off and the system's Reduce motion.

const still = () => document.documentElement.dataset.still !== undefined || window.matchMedia('(prefers-reduced-motion: reduce)').matches
const SPRING = 'cubic-bezier(.3, 1.3, .5, 1)'
const EASE = 'cubic-bezier(.2, .8, .2, 1)'

function rowsOf(keys: string[]): HTMLElement[] {
  const box = document.querySelector('.list .rows')
  if (!box) return []
  return keys.map((k) => box.querySelector<HTMLElement>(`[data-k="${CSS.escape(k)}"]`)).filter((el): el is HTMLElement => !!el)
}

/** archived, deleted, moved, snoozed: the rows slide out and close up; resolves when the list may drop them */
export function leave(keys: string[]): Promise<void> {
  const els = rowsOf(keys)
  if (still() || !els.length || els.length > 24) return Promise.resolve()
  const runs = els.map((el) =>
    el.animate(
      [
        { height: `${el.offsetHeight}px`, marginBottom: '2px', opacity: 1, transform: 'none' },
        { height: `${el.offsetHeight}px`, marginBottom: '2px', opacity: 0, transform: 'translateX(-34px) scale(.97)', offset: 0.55 },
        { height: '0px', marginBottom: '0px', opacity: 0, transform: 'translateX(-34px) scale(.97)' },
      ],
      { duration: 230, easing: EASE, fill: 'forwards' },
    ))
  // a row that stays after all (the server said no and the list reloaded) opens up again
  setTimeout(() => runs.forEach((a) => a.cancel()), 1500)
  return new Promise((done) => setTimeout(done, 220))
}

/** new mail, or rows brought back by Undo: they drop in from above with a short glow */
export function arrive(keys: string[]): void {
  if (still() || !keys.length) return
  rowsOf(keys.slice(0, 8)).forEach((el, i) => {
    el.animate(
      [{ opacity: 0, transform: 'translateY(-14px) scale(.97)' }, { opacity: 1, transform: 'none' }],
      { duration: 420, delay: i * 40, easing: SPRING, fill: 'backwards' },
    )
    el.classList.remove('fresh')
    void el.offsetWidth
    el.classList.add('fresh')
    setTimeout(() => el.classList.remove('fresh'), 1400)
  })
}
