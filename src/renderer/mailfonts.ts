// Fonts for the mail you write (Alex, 3 Nov 2026: "can I use other fonts, and will they arrive as I wrote them?").
// A mail carries only a font's name: the reader sees it only if their own computer or phone has it. So the composer
// offers first the fonts every Mac, Windows, iPhone and Android has, then the ones on this computer, each with a
// fallback of the same kind, so whoever lacks it sees something close instead of whatever their app picks.

/** the fonts every reader has, with what stands in for them where they are missing */
export const SAFE_FONTS: [string, string][] = [
  ['System', "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"],
  ['Arial', 'Arial, Helvetica, sans-serif'],
  ['Helvetica', 'Helvetica, Arial, sans-serif'],
  ['Verdana', 'Verdana, Geneva, sans-serif'],
  ['Tahoma', 'Tahoma, Verdana, Geneva, sans-serif'],
  ['Trebuchet MS', "'Trebuchet MS', Helvetica, Arial, sans-serif"],
  ['Georgia', "Georgia, 'Times New Roman', serif"],
  ['Times New Roman', "'Times New Roman', Times, serif"],
  ['Palatino', "'Palatino Linotype', Palatino, 'Book Antiqua', Georgia, serif"],
  ['Courier New', "'Courier New', Courier, monospace"],
]

/** a font of this computer with a safe one after it, of the same kind */
export function localStack(family: string): string {
  const f = family.replace(/['"\\]/g, '')
  const n = f.toLowerCase()
  const back = /mono|courier|code|consol/.test(n) ? "'Courier New', monospace"
    : /serif|times|garamond|georgia|palatino|baskerville|didot|bodoni|caslon|book|minion|playfair|lora|merriweather/.test(n) && !/sans/.test(n) ? "Georgia, 'Times New Roman', serif"
    : 'Helvetica, Arial, sans-serif'
  return `'${f}', ${back}`
}

/** a setting's value ('safe:Arial', 'local:Futura', '' for none) as a CSS font stack ('' for none) */
export function mailFontStack(v: string): string {
  if (!v) return ''
  if (v.startsWith('local:')) return localStack(v.slice(6))
  const name = v.replace(/^safe:/, '')
  return SAFE_FONTS.find(([n]) => n === name)?.[1] || ''
}

const LOCAL_KEY = 'roarmail.localFonts'
/** the fonts installed here, remembered after they were read once (reading them needs a click) */
export function knownLocalFonts(): string[] {
  try { const v = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); return Array.isArray(v) ? v : [] } catch { return [] }
}
export async function readLocalFonts(): Promise<string[]> {
  const q = (window as any).queryLocalFonts as undefined | (() => Promise<{ family: string }[]>)
  if (!q) return []
  const safe = new Set(SAFE_FONTS.map(([n]) => n.toLowerCase()))
  const fams = [...new Set((await q()).map((f) => f.family))].filter((f) => f && !f.startsWith('.') && !safe.has(f.toLowerCase())).sort((x, y) => x.localeCompare(y))
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(fams)) } catch { /* read again next time */ }
  return fams
}

/** the message's own font around what was written, so it arrives in it; a message that has one keeps it */
export const FONT_MARK = 'data-roarmail-font'
export function withMailFont(html: string, stack: string): string {
  if (!stack || !html.trim() || html.trimStart().startsWith(`<div ${FONT_MARK}`)) return html
  return `<div ${FONT_MARK}="" style="font-family:${stack.replace(/"/g, "'")}">${html}</div>`
}
