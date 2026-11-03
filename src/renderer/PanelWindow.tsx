// Settings, Files, Contacts and Statistics in windows of their own (Alex, 3 Nov 2026: "everything that pops up is stuck
// to the background"). The main process opens index.html#panel=<kind>&id=<id>; this page shows only that sheet, filling
// the window (look.css html.panel-window). What it asks of the main window goes there (toMain); closing closes the window.
import { useEffect, useState } from 'react'
import type { Account, Rule, Settings } from '../shared/api'
import { applyLook } from './look'
import { ContactsSheet } from './components/Contacts'
import { FilesSheet } from './components/Files'
import { StatsSheet } from './components/Stats'
import { SettingsSheet, type Page } from './components/SettingsSheet'

const api = window.roarmail
export type PanelKind = 'settings' | 'files' | 'contacts' | 'stats'
const close = () => { api.composeClose?.() }

export function PanelWindow({ kind, id }: { kind: PanelKind; id: string }) {
  const [seed, setSeed] = useState<any>(undefined)
  const [accounts, setAccounts] = useState<Account[] | null>(null)
  const [prefs, setPrefs] = useState<Settings | null>(null)
  // a new starting point while open (Make a Rule from This Sender, another contact) remounts the sheet there
  const [round, setRound] = useState(0)
  useEffect(() => {
    document.documentElement.classList.add('panel-window')
    api.composeSeed?.(id).then((s) => setSeed(s ?? null)).catch(() => setSeed(null))
    const load = () => { api.accounts().then(setAccounts).catch(() => setAccounts([])); api.settings().then(setPrefs).catch(() => {}) }
    load()
    return api.on((e) => {
      if (e.type === 'accounts') load()
      if (e.type === 'settings' && kind !== 'settings') api.settings().then((s) => { setPrefs(s); applyLook(s) }).catch(() => {})
      if (e.type === 'panelSeed') { setSeed(e.seed); setRound((n) => n + 1) }
    })
  }, [id, kind])
  if (seed === undefined || !accounts || !prefs) return <div className="boot" />
  const toMain = api.toMain!
  if (kind === 'settings') {
    const start = seed && (seed as { page?: Page }).page ? (seed as { page: Page; rule?: Rule }) : null
    return <SettingsSheet key={round} accounts={accounts} start={start} onAddAccount={() => toMain({ do: 'addAccount' })} onLook={(s) => { setPrefs(s); applyLook(s) }} onClose={close} />
  }
  if (kind === 'files') {
    return <FilesSheet accounts={accounts} onClose={close}
      onPerson={(person) => toMain({ do: 'scope', accountId: 'all', person })}
      onCard={(email) => api.panelWindow?.('contacts', { email })}
      onOpenMail={(f) => toMain({ do: 'openMail', id: f.messageId, subject: f.subject })} />
  }
  if (kind === 'contacts') {
    return <ContactsSheet key={round} start={(seed as { email?: string } | null)?.email || undefined} pictures={prefs.senderPictures} onClose={close}
      onWrite={(to) => api.composeWindow?.({ kind: 'new', to })}
      onAllMail={(person) => toMain({ do: 'scope', accountId: 'all', person })} />
  }
  return <StatsSheet accounts={accounts} onClose={close} onOpen={(accountId, sender) => toMain({ do: 'scope', accountId, role: 'inbox', person: sender })} />
}
