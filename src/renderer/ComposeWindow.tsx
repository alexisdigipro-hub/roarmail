// A new message in a window of its own (Alex, 3 Nov 2026: "I move the new message and the whole RoarMail moves").
// The main process opens index.html#compose=<id>; this page asks what to start from and shows only the Composer.
// Sending or saving tells the main window (its toast with Undo), then the window closes.
import { useEffect, useState } from 'react'
import type { Account } from '../shared/api'
import { Composer, type ComposeSeed } from './components/Composer'

const api = window.roarmail

export function ComposeWindow({ id }: { id: string }) {
  const [seed, setSeed] = useState<ComposeSeed | null>(null)
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [gone, setGone] = useState(false)
  useEffect(() => {
    document.documentElement.classList.add('compose-window')
    api.composeSeed?.(id).then((s) => { if (s) setSeed(s as ComposeSeed); else setGone(true) }).catch(() => setGone(true))
    api.accounts().then(setAccounts).catch(() => setAccounts([]))
  }, [id])
  // a window whose message is gone (RoarMail restarted under it) simply closes
  useEffect(() => { if (gone) api.composeClose?.() }, [gone])
  if (!seed || !accounts) return <div className="boot" />
  return (
    <Composer windowed seed={seed} accounts={accounts}
      onClose={(saved) => { api.composeDone?.({ saved }); api.composeClose?.() }}
      onSent={(outboxId, at) => { api.composeDone?.({ outboxId, at }); api.composeClose?.() }} />
  )
}
