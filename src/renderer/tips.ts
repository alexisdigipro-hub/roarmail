// Every icon says what it does on hover (Alex, 29 Oct: "where there are little symbols, hover shows what it is;
// nobody can guess"). The title attributes become our own bubble: it comes in a third of a second instead of the
// system's second and more, and it also shows over buttons that are greyed out.
let tip: HTMLDivElement | null = null
let timer: ReturnType<typeof setTimeout> | undefined
let over: HTMLElement | null = null

const hide = () => { clearTimeout(timer); over = null; tip?.classList.remove('show') }

function show(el: HTMLElement) {
  const text = el.dataset.tip
  if (!text || !el.isConnected) return
  if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip) }
  tip.textContent = text
  tip.classList.add('show')
  const r = el.getBoundingClientRect(), w = tip.offsetWidth, h = tip.offsetHeight
  const below = r.bottom + 8 + h < innerHeight
  tip.style.left = `${Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`
  tip.style.top = `${below ? r.bottom + 8 : r.top - h - 8}px`
}

addEventListener('mouseover', (e) => {
  const el = (e.target as HTMLElement | null)?.closest?.('[title], [data-tip]') as HTMLElement | null
  if (el === over) return
  hide()
  if (!el) return
  const title = el.getAttribute('title')
  if (title != null) { if (title) el.dataset.tip = title; el.removeAttribute('title') }
  if (!el.dataset.tip) return
  over = el
  timer = setTimeout(() => show(el), tip?.classList.contains('show') ? 0 : 320)
}, true)
for (const ev of ['mousedown', 'wheel', 'keydown', 'blur']) addEventListener(ev, hide, true)
document.addEventListener('mouseleave', hide)
