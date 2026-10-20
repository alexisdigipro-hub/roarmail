// RoarMe's look, in RoarMail: the same themes (Simba, Pumba), accents, fonts, density, corners, motion, focus
// rings, glass and power saving, applied the way RoarMe's applyLook does (CSS variables and data attributes on
// <html>), plus the sliding "lens" under the chosen item and the circle wipe when day turns to night.
import { useLayoutEffect, useRef } from 'react'
import '@fontsource/inter/400.css'
import '@fontsource/inter/600.css'
import '@fontsource/manrope/400.css'
import '@fontsource/manrope/700.css'
import '@fontsource/dm-sans/400.css'
import '@fontsource/dm-sans/600.css'
import '@fontsource/space-grotesk/400.css'
import '@fontsource/space-grotesk/600.css'
import '@fontsource/jetbrains-mono/400.css'
import type { Settings } from '../shared/api'

export const LOOK_DEFAULTS = {
  theme: 'simba', accent: 'red', font: 'system', density: 'standard', radius: 12,
  motion: true, focusRings: false, glass: true, textSize: 2, lite: false,
  listFont: 'system', listSize: 14, messageFont: 'system', monoFont: 'mono', plainMono: false,
  quoteColors: true, quote1: '#6d5dfc', quote2: '#1fa3b8', quote3: '#3fae49',
} as const satisfies Partial<Settings>

/** Settings > General, as the main process starts them (src/main/mail.ts SETTINGS) */
export const GENERAL_DEFAULTS = {
  checkEvery: 5, newMailSound: 'system', actionSounds: false, dockBadge: 'inbox', notifyFor: 'inbox',
  downloadsFolder: '', retrySending: true, searchTrash: true, searchJunk: true,
  language: 'auto', unifiedInbox: true, linksInBackground: false, dockMode: 'both', notifyReply: true, markRead: 'open',
  accountColours: true, accountBadges: true, inboxCounter: 'unread', folderCounter: 'unread',
  privacyMode: false, searchConversations: false, exactSearch: false, onlineSearch: false, detectLinks: true,
  autoUpdate: true,
} as const satisfies Partial<Settings>

/** a font setting as CSS: one of FONTS, or a font installed on this computer ('local:<family>') */
export function fontStack(key: string | undefined, fallback = FONTS[0][2]) {
  if (key?.startsWith('local:')) return `"${key.slice(6).replace(/["\\]/g, '')}", ${fallback}`
  return FONTS.find(([k]) => k === key)?.[2] || fallback
}
export const fontName = (key: string) => (key.startsWith('local:') ? key.slice(6) : FONTS.find(([k]) => k === key)?.[1] || key)

// RoarMe's accents (prefs.js ACCENTS), same order and values
export const ACCENTS: [string, string, string][] = [
  ['blue', 'Blue', '#3b82f6'], ['green', 'Green', '#22c55e'], ['yellow', 'Yellow', '#facc15'], ['orange', 'Orange', '#f97316'],
  ['red', 'Red', '#d40000'], ['magenta', 'Magenta', '#d946ef'], ['violet', 'Violet', '#8b5cf6'], ['cyan', 'Cyan', '#22d3ee'],
  ['coral', 'Coral', '#ff6b57'], ['white', 'White', '#ffffff'],
]

export const FONTS: [Settings['font'], string, string][] = [
  ['system', 'SF Pro', "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Inter, Roboto, sans-serif"],
  ['inter', 'Inter', "Inter, -apple-system, 'Segoe UI', sans-serif"],
  ['manrope', 'Manrope', "Manrope, -apple-system, 'Segoe UI', sans-serif"],
  ['dmsans', 'DM Sans', "'DM Sans', -apple-system, 'Segoe UI', sans-serif"],
  ['grotesk', 'Space Grotesk', "'Space Grotesk', -apple-system, 'Segoe UI', sans-serif"],
  ['serif', 'Serif', "Georgia, 'Times New Roman', serif"],
  ['mono', 'Mono', "'JetBrains Mono', ui-monospace, Menlo, monospace"],
]

export const TEXT_SIZES = [13.5, 14.5, 15.5, 17, 18.5]

const inkOn = (hex: string) => {
  const n = parseInt(hex.slice(1), 16)
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 160 ? '#111111' : '#ffffff'
}

const dark = () => window.matchMedia('(prefers-color-scheme: dark)')
let followSystem: (() => void) | null = null

export function applyLook(s: Settings) {
  const r = document.documentElement
  r.dataset.theme = s.theme || 'simba'
  const hex = ACCENTS.find(([k]) => k === s.accent)?.[2]
  if (hex) {
    r.style.setProperty('--accent', hex)
    r.style.setProperty('--accent-2', hex === '#d40000' ? '#ff3b30' : hex)
    r.style.setProperty('--accent-ink', inkOn(hex))
  } else ['--accent', '--accent-2', '--accent-ink'].forEach((v) => r.style.removeProperty(v))
  const f = FONTS.find(([k]) => k === s.font)
  if (f && s.font !== 'system') { r.style.setProperty('--font', f[2]); r.dataset.font = s.font } else { r.style.removeProperty('--font'); delete r.dataset.font }
  r.dataset.density = s.density || 'standard'
  const rad = Number(s.radius) || 12
  r.style.setProperty('--r', `${rad}px`)
  r.style.setProperty('--R', `${Math.round(rad * 1.6)}px`)
  r.style.setProperty('--fs', `${TEXT_SIZES[s.textSize ?? 2] ?? 15.5}px`)
  // Settings > Fonts & colours: the message list's own font and size
  if (s.listFont && s.listFont !== 'system') r.style.setProperty('--list-font', fontStack(s.listFont)); else r.style.removeProperty('--list-font')
  r.style.setProperty('--list-fs', `${Number(s.listSize) || 14}px`)
  if (s.motion === false) r.dataset.still = '1'; else delete r.dataset.still
  if (s.focusRings) r.dataset.focus = 'bold'; else delete r.dataset.focus
  r.dataset.surface = s.glass === false ? 'solid' : 'glass'
  if (s.lite) r.dataset.lite = '1'; else delete r.dataset.lite
  applyMode(s.appearance)
  window.dispatchEvent(new Event('roarmail-look'))
}

/** Day and Night: dark, light, or with the system (listening for it to change) */
export function applyMode(mode: Settings['appearance']) {
  const r = document.documentElement
  if (followSystem) { dark().removeEventListener('change', followSystem); followSystem = null }
  const set = () => { r.dataset.mode = mode === 'light' || (mode === 'system' && !dark().matches) ? 'light' : 'dark' }
  set()
  if (mode === 'system') { followSystem = set; dark().addEventListener('change', set) }
}

const calm = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
  || document.documentElement.dataset.still === '1' || document.documentElement.dataset.lite === '1'

/** RoarMe's circle wipe: the new look spreads out from where you clicked (View Transitions) */
export function revealFrom(e: { clientX: number; clientY: number } | null, change: () => void) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => { ready: Promise<void> } }
  if (!doc.startViewTransition || calm() || !e) { change(); return }
  const x = e.clientX, y = e.clientY
  const end = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y))
  const t = doc.startViewTransition(change)
  t.ready.then(() => {
    document.documentElement.animate(
      { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${end}px at ${x}px ${y}px)`] },
      { duration: 620, easing: 'cubic-bezier(.7, 0, .3, 1)', pseudoElement: '::view-transition-new(root)' },
    )
  }).catch(() => {})
}

/**
 * RoarMe's lens: the container gets class "lens", the chosen child has "on"; this measures the chosen child
 * and moves a pill (the container's ::before) under it with a spring. Works across and down.
 */
export function useLens<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const put = () => {
      const on = el.querySelector(':scope > .on') as HTMLElement | null
      if (!on) { el.classList.remove('lens-on'); return }
      el.style.setProperty('--lx', `${on.offsetLeft}px`)
      el.style.setProperty('--ly', `${on.offsetTop}px`)
      el.style.setProperty('--lw', `${on.offsetWidth}px`)
      el.style.setProperty('--lh', `${on.offsetHeight}px`)
      el.classList.add('lens-on')
    }
    put()
    const ro = new ResizeObserver(put)
    ro.observe(el)
    ;[...el.children].forEach((c) => ro.observe(c))
    const later = () => requestAnimationFrame(() => requestAnimationFrame(put))
    window.addEventListener('roarmail-look', later)
    return () => { ro.disconnect(); window.removeEventListener('roarmail-look', later) }
  }, [dep])
  return ref
}
