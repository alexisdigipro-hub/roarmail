// Pictures of senders (Appearance > List): asked for in batches as rows appear, kept for the session here and
// on this computer by the engine (src/main/mail.ts senderIcons). The list and the reader share them.
import { useEffect, useState } from 'react'

const cache = new Map<string, string | null>()
// a contact's photo was set or taken away (19 Nov 2026): that address is asked for again, in every window
try {
  window.roarmail?.on?.((e: any) => {
    if (e?.type !== 'contactPhoto' || !e.email) return
    cache.delete(e.email); waiting.add(e.email)
    if (!timer) timer = setTimeout(flush, 30)
  })
} catch { /* the web demo */ }
const waiting = new Set<string>()
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setTimeout> | undefined

function flush() {
  timer = undefined
  const batch = [...waiting].slice(0, 60)
  batch.forEach((e) => waiting.delete(e))
  if (!batch.length) return
  window.roarmail.senderIcons(batch).then((found) => {
    for (const e of batch) cache.set(e, found[e] ?? null)
    listeners.forEach((l) => l())
  }).catch(() => { for (const e of batch) cache.set(e, null) })
  if (waiting.size) timer = setTimeout(flush, 80)
}

/** the picture for each sender, once known; null while unknown or when there is none */
export function useSenderIcons(emails: string[], _found?: boolean): (email: string) => string | null {
  const [, tick] = useState(0)
  const key = emails.join(',')
  useEffect(() => {
    const l = () => tick((n) => n + 1)
    listeners.add(l)
    return () => { listeners.delete(l) }
  }, [])
  useEffect(() => {
    for (const raw of emails) {
      const e = raw.toLowerCase()
      if (e && !cache.has(e) && !waiting.has(e)) waiting.add(e)
    }
    if (waiting.size && !timer) timer = setTimeout(flush, 30)
  }, [key])
  return (email: string) => cache.get(email.toLowerCase()) ?? null
}
