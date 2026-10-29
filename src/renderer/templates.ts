// Templates (quick replies): the placeholders a saved text carries, filled in when it is dropped into a message.
// Plain functions, checked by test/templates.test.ts.

export interface TemplateValues {
  /** the person written to: "Μαρία Παπαδοπούλου" (or their address when there is no name) */
  name: string
  /** the project typed in the Templates menu (kept for next time) */
  project: string
  /** today, as the app writes dates */
  date: string
}

/** "Μαρία Παπαδοπούλου <maria@x.gr>, nikos@y.gr" -> the first person's name, else the part of the address before @ */
export function recipientName(to: string): string {
  // the first address; a comma inside quotes ("Doe, John") is part of the name
  const first = (to.match(/(?:"[^"]*"|[^,;"])+/g) || []).map((x) => x.trim()).find(Boolean) || ''
  const named = first.match(/^"?([^"<]*?)"?\s*<[^>]+>$/)
  if (named && named[1].trim()) return named[1].trim()
  const addr = first.replace(/^<|>$/g, '')
  return addr.includes('@') ? addr.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : addr
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

/**
 * {name} {first} {project} {date} filled in; html: true escapes what goes in (the template body is HTML).
 * A placeholder with nothing to put there is left as it is, so it shows what still needs writing.
 */
export function fillTemplate(text: string, v: TemplateValues, html = false): string {
  const first = v.name.trim().split(/\s+/)[0] || ''
  const map: Record<string, string> = { name: v.name.trim(), first, project: v.project.trim(), date: v.date }
  return text.replace(/\{(name|first|project|date)\}/gi, (whole, k: string) => {
    const val = map[k.toLowerCase()]
    return val ? (html ? esc(val) : val) : whole
  })
}
