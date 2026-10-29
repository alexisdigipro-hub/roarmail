// Statistics (29 Oct 2026): how full each mailbox is on the server, how much mail there is, who sends the most
// (by size or by count), how much of it is attachments, and the biggest messages; one account or all of them.
import { useEffect, useState } from 'react'
import type { Account, MailStats } from '../../shared/api'
import { size, t, when } from '../i18n'
import { Icon } from './Icon'

export function StatsSheet({ accounts, onClose, onOpen }: { accounts: Account[]; onClose: () => void; onOpen: (accountId: string, sender: string) => void }) {
  const [scope, setScope] = useState('all')
  const [s, setS] = useState<MailStats | null>(null)
  const [by, setBy] = useState<'bytes' | 'count'>('bytes')

  useEffect(() => {
    let live = true
    setS(null)
    window.roarmail.stats(scope).then((r) => { if (live) setS(r) }).catch(() => { if (live) setS({ accounts: [], senders: [], biggest: [], cache: 0 }) })
    return () => { live = false }
  }, [scope])

  const total = s?.accounts.reduce((a, x) => ({ messages: a.messages + x.messages, unread: a.unread + x.unread, bytes: a.bytes + x.bytes,
    att: a.att + x.withAttachments, attBytes: a.attBytes + x.attachmentBytes }), { messages: 0, unread: 0, bytes: 0, att: 0, attBytes: 0 })
  const senders = s ? [...s.senders].sort((a, b) => (by === 'bytes' ? b.bytes - a.bytes : b.count - a.count)).slice(0, 15) : []
  const top = senders[0] ? (by === 'bytes' ? senders[0].bytes : senders[0].count) : 1

  return (
    <div className="sheet-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }} onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
      <div className="sheet stats" tabIndex={-1}>
        <div className="row">
          <h1 className="grow">{t.st_title}</h1>
          <button className="tool" title={t.cancel} onClick={onClose}><Icon name="close" /></button>
        </div>
        <div className="acct-pick">
          <button className={`acct-chip ${scope === 'all' ? 'on' : ''}`} onClick={() => setScope('all')}>{t.allAccounts}</button>
          {accounts.filter((a) => a.enabled).map((a) => (
            <button key={a.id} className={`acct-chip ${scope === a.id ? 'on' : ''}`} onClick={() => setScope(a.id)}>
              <i className="acc-dot" style={{ background: a.color }} /> <span className="ellipsis">{a.description || a.displayName || a.email}</span>
            </button>
          ))}
        </div>

        {!s ? <div className="stats-wait"><div className="spinner" /></div> : (
          <div className="stack">
            <section className="card">
              <h3>{t.st_space}</h3>
              {s.accounts.map((a) => (
                <div className="st-quota" key={a.id}>
                  <div className="row"><i className="acc-dot" style={{ background: a.color }} /><b className="grow ellipsis">{a.email}</b>
                    <span className="muted small">{a.quota ? `${size(a.quota.used)} / ${size(a.quota.limit)}` : t.st_noQuota}</span></div>
                  {a.quota && (
                    <div className={`st-bar ${a.quota.used / a.quota.limit > 0.9 ? 'full' : ''}`}><i style={{ width: `${Math.min(100, (a.quota.used / a.quota.limit) * 100)}%` }} /></div>
                  )}
                </div>
              ))}
              <p className="muted small">{t.st_cache} {size(s.cache)}</p>
            </section>

            {total && (
              <section className="card st-tiles">
                <Tile label={t.st_messages} value={total.messages.toLocaleString()} />
                <Tile label={t.st_unread} value={total.unread.toLocaleString()} />
                <Tile label={t.st_size} value={size(total.bytes)} />
                <Tile label={t.st_withAtt} value={`${total.att.toLocaleString()} · ${size(total.attBytes)}`} />
              </section>
            )}

            {scope !== 'all' && s.accounts[0] && (
              <section className="card">
                <h3>{t.st_folders}</h3>
                {s.accounts[0].folders.filter((f) => f.count > 0 || f.onServer > 0).map((f, i) => (
                  <div className="st-line" key={i}>
                    <span className="grow ellipsis">{f.role ? (t as Record<string, string>)[f.role] || f.name : f.name}</span>
                    <span className="muted small">{f.count.toLocaleString()}{f.onServer > f.count ? ` / ${f.onServer.toLocaleString()}` : ''}</span>
                    <span className="st-num">{size(f.bytes)}</span>
                  </div>
                ))}
                <p className="muted small">{t.st_foldersHint}</p>
              </section>
            )}

            <section className="card">
              <div className="row">
                <h3 className="grow">{t.st_senders}</h3>
                <div className="seg small">
                  <button className={by === 'bytes' ? 'on' : ''} onClick={() => setBy('bytes')}>{t.st_bySize}</button>
                  <button className={by === 'count' ? 'on' : ''} onClick={() => setBy('count')}>{t.st_byCount}</button>
                </div>
              </div>
              {senders.map((x) => (
                <button className="st-sender" key={x.email} title={x.email} onClick={() => onOpen(scope, x.email)}>
                  <span className="grow ellipsis"><b>{x.name || x.email}</b>{x.name && <small className="muted"> {x.email}</small>}</span>
                  <span className="muted small">{x.count.toLocaleString()} · {x.withAttachments > 0 && <><Icon name="clip" size={12} /> {x.withAttachments} · </>}</span>
                  <span className="st-num">{size(x.bytes)}</span>
                  <i className="st-fill" style={{ width: `${((by === 'bytes' ? x.bytes : x.count) / top) * 100}%` }} />
                </button>
              ))}
              {!senders.length && <p className="muted">{t.empty}</p>}
            </section>

            <section className="card">
              <h3>{t.st_biggest}</h3>
              {s.biggest.map((m) => (
                <div className="st-line" key={m.id}>
                  {m.attachments ? <Icon name="clip" size={13} /> : <span className="st-gap" />}
                  <span className="grow ellipsis"><b>{m.subject || t.noSubject}</b> <small className="muted">{m.from}</small></span>
                  <span className="muted small">{when(m.date)}</span>
                  <span className="st-num">{size(m.bytes)}</span>
                </div>
              ))}
            </section>
            <p className="muted small">{t.st_note}</p>
          </div>
        )}
      </div>
    </div>
  )
}

function Tile({ label, value }: { label: string; value: string }) {
  return <div className="st-tile"><small className="muted">{label}</small><b>{value}</b></div>
}
