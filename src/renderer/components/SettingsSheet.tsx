// Settings, laid out like RoarMe's: a list of pages on the left (icons, current values, a chevron, the lens
// sliding to the open one), the page on the right with a big title. Appearance carries RoarMe's look settings.
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import DOMPurify from 'dompurify'
import type { Account, Folder, LockState, NewMailSound, Rule, Settings, Signature, SwipeAction, Tls, UpdateState } from '../../shared/api'
import { lang, t, when, type Key } from '../i18n'
import { ACCENTS, FONTS, TEXT_SIZES, applyLook, fontStack, revealFrom, useLens } from '../look'
import { NEW_MAIL_SOUNDS, playNewMail } from '../sounds'
import { Icon } from './Icon'
import { RoarMeAccount } from './RoarMe'
import { RulesPage } from './Rules'
import { TemplatesPage } from './Templates'

const COLORS = ['#d40000', '#ff8a00', '#2f9bff', '#33c27f', '#b04cff', '#ff4fa3', '#00b8b0', '#c9a227']
const MAC = window.roarmail.platform === 'darwin'

// The pages, in five groups (Alex, 21 Oct 2026: "tidy, in categories"), like the Mac's System Settings
export type Page = 'accounts' | 'signatures' | 'roarme' | 'general' | 'reading' | 'composing' | 'rules' | 'templates' | 'notify' | 'search'
  | 'theme' | 'list' | 'fonts' | 'privacy' | 'updates' | 'keys' | 'expert'
const GROUPS: [Key, [Page, string][]][] = [
  ['grp_accounts', [['accounts', 'inbox'], ['signatures', 'compose'], ['roarme', 'roar']]],
  ['grp_mail', [['general', 'gear'], ['reading', 'unread'], ['composing', 'sent'], ['rules', 'funnel'], ['templates', 'template'], ['notify', 'bell'], ['search', 'search']]],
  ['grp_look', [['theme', 'palette'], ['list', 'all'], ['fonts', 'type']]],
  ['grp_privacy', [['privacy', 'shield']]],
  ['grp_system', [['updates', 'download'], ['keys', 'keyboard'], ['expert', 'sliders']]],
]
const title = (p: Page) => t[`pg_${p}` as Key]

type Set = <K extends keyof Settings>(k: K, v: Settings[K], e?: MouseEvent) => void

export function SettingsSheet({ accounts, onAddAccount, onClose, onLook, start }: {
  accounts: Account[]; onAddAccount: () => void; onClose: () => void; onLook: (s: Settings) => void
  /** open at this page (Make a Rule from This Sender opens Rules with the rule started) */
  start?: { page: Page; rule?: Rule } | null
}) {
  const [page, setPage] = useState<Page>(start?.page || 'general')
  const [sigs, setSigs] = useState<Signature[]>([])
  const [prefs, setPrefs] = useState<Settings | null>(null)
  const nav = useLens<HTMLDivElement>(page)
  const upd = useUpdate()
  const loadSigs = () => window.roarmail.signatures().then(setSigs)
  useEffect(() => { loadSigs(); window.roarmail.settings().then(setPrefs) }, [])

  // one way to change a setting, for every page: kept, applied to the look, told to the window
  const set: Set = (k, v, e) => {
    if (!prefs) return
    const next = { ...prefs, [k]: v }
    window.roarmail.setSetting(k, v)
    const apply = () => { setPrefs(next); applyLook(next); onLook(next) }
    if (e && (k === 'appearance' || k === 'theme')) revealFrom(e, apply); else apply()
  }
  const replace = (n: Settings) => { setPrefs(n); applyLook(n); onLook(n) }

  const value = (p: Page) => {
    if (!prefs) return ''
    if (p === 'accounts') return String(accounts.length)
    if (p === 'theme') return prefs.theme === 'pumba' ? 'Pumba' : 'Simba'
    if (p === 'signatures') return sigs.length ? String(sigs.length) : ''
    if (p === 'privacy') return prefs.privacyMode ? t.on : prefs.lock ? t.appLockShort : ''
    if (p === 'updates') return upd?.status === 'ready' ? t.up_readyShort : upd?.current || ''
    return ''
  }

  return (
    <div className="sheet-wrap" onKeyDown={(e) => { if (e.key === 'Escape') onClose() }} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet settings">
        <nav className="set-side">
          <div className="set-brand"><b>ROAR</b><i>MAIL</i></div>
          <div className="set-list list-lens lens" ref={nav}>
            {GROUPS.flatMap(([g, pages]) => [
              <div key={g} className="set-group-title">{t[g]}</div>,
              ...pages.map(([k, icon]) => (
                <button key={k} className={`set-nav ${page === k ? 'on' : ''}`} onClick={() => setPage(k)}>
                  <Icon name={icon} size={16} />
                  <span className="grow ellipsis">{title(k)}</span>
                  <span className="set-val">{value(k)}</span>
                </button>
              )),
            ])}
          </div>
        </nav>
        <section className="set-page" key={page}>
          <div className="set-head">
            <h2>{title(page)}</h2>
            <button className="tool" onClick={onClose} title={t.done}><Icon name="close" /></button>
          </div>
          <div className="settings-body">
            {page === 'accounts' && <Accounts accounts={accounts} sigs={sigs} onAdd={onAddAccount} />}
            {page === 'signatures' && <Signatures sigs={sigs} reload={loadSigs} />}
            {page === 'roarme' && <RoarMeAccount />}
            {page === 'rules' && <RulesPage accounts={accounts} seed={start?.page === 'rules' ? start.rule : null} />}
            {page === 'templates' && <TemplatesPage />}
            {page === 'keys' && <Shortcuts />}
            {prefs && page === 'general' && <General s={prefs} set={set} />}
            {prefs && page === 'reading' && <Reading s={prefs} set={set} />}
            {prefs && page === 'composing' && <Composing s={prefs} set={set} />}
            {prefs && page === 'notify' && <Notify s={prefs} set={set} />}
            {prefs && page === 'search' && <Search s={prefs} set={set} />}
            {prefs && page === 'theme' && <Theme s={prefs} set={set} />}
            {prefs && page === 'list' && <ListPage s={prefs} set={set} />}
            {prefs && page === 'fonts' && <Fonts s={prefs} set={set} />}
            {prefs && page === 'privacy' && <Privacy s={prefs} set={set} />}
            {prefs && page === 'updates' && <Updates s={prefs} set={set} />}
            {prefs && page === 'expert' && <Advanced replace={replace} />}
          </div>
        </section>
      </div>
    </div>
  )
}

/** a titled card of settings; the note sits under it */
function Group({ title, note, children }: { title?: string; note?: string; children: ReactNode }) {
  return (
    <section className="set-sec">
      {title && <h4 className="set-sub">{title}</h4>}
      <div className="set-group">{children}</div>
      {note && <p className="muted small set-note">{note}</p>}
    </section>
  )
}

/** one line of a card: what it is (and a hint) on the left, the control on the right */
function Line({ label, hint, children }: { label: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <div className="set-row">
      <span className="set-label">{label}{hint && <small className="muted block">{hint}</small>}</span>
      <span className="set-ctl">{children}</span>
    </div>
  )
}

function Choice<V extends string | number>({ value, options, onChange }: { value: V; options: [V, string][]; onChange: (v: V) => void }) {
  return (
    <select value={value} onChange={(e) => onChange((typeof value === 'number' ? Number(e.target.value) : e.target.value) as V)}>
      {options.map(([v, label]) => <option key={String(v)} value={v}>{label}</option>)}
    </select>
  )
}

/** Mail > General: the app itself on this computer */
function General({ s, set }: { s: Settings; set: Set }) {
  const [isDefault, setIsDefault] = useState<boolean | null>(null)
  useEffect(() => { window.roarmail.isDefaultMail().then(setIsDefault).catch(() => {}) }, [])
  return (
    <div className="stack">
      <Group title={t.sec_app}>
        <Line label={t.g_language}>
          <Choice value={s.language} onChange={(v) => set('language', v)} options={[['auto', t.g_langAuto], ['el', 'Ελληνικά'], ['en', 'English']]} />
        </Line>
        <Line label={t.g_defaultApp}>
          {isDefault
            ? <span className="muted small ok-text"><Icon name="shield" size={14} /> RoarMail</span>
            : <button className="pill small" disabled={isDefault == null} onClick={() => window.roarmail.makeDefaultMail().then(setIsDefault)}>{t.g_makeDefault}</button>}
        </Line>
        <Toggle label={t.runAtLoginShort} hint={t.runAtLogin} on={s.runAtLogin} set={(v) => set('runAtLogin', v)} />
        {MAC && (
          <Line label={t.g_dock}>
            <Choice value={s.dockMode} onChange={(v) => set('dockMode', v)} options={[['both', t.g_dockBoth], ['dock', t.g_dockOnly], ['menubar', t.g_menubarOnly]]} />
          </Line>
        )}
      </Group>
      <Group title={t.sec_inboxes}>
        <Toggle label={t.g_unified} hint={t.g_unifiedHint} on={s.unifiedInbox} set={(v) => set('unifiedInbox', v)} />
        <Line label={t.g_checkEvery}>
          <Choice value={s.checkEvery} onChange={(v) => set('checkEvery', v)}
            options={[[1, t.g_every1], [5, t.g_every5], [15, t.g_every15], [30, t.g_every30], [60, t.g_every60], [0, t.g_manually]]} />
        </Line>
      </Group>
    </div>
  )
}

/** Mail > Reading: what happens while reading and acting on mail */
function Reading({ s, set }: { s: Settings; set: Set }) {
  const swipes: [SwipeAction, string][] = (['archive', 'trash', 'snooze', 'flag', 'seen', 'none'] as SwipeAction[]).map((w) => [w, t[`sw_${w}` as Key]])
  const folderName = s.downloadsFolder.split(/[\\/]/).filter(Boolean).pop() || ''
  return (
    <div className="stack">
      <Group title={t.sec_reading}>
        <Line label={t.g_markRead}>
          <Choice value={s.markRead} onChange={(v) => set('markRead', v)} options={[['open', t.g_readOpen], ['delay', t.g_readDelay], ['never', t.g_readNever]]} />
        </Line>
        <Toggle label={t.ad_detect} hint={t.ad_detectHint} on={s.detectLinks} set={(v) => set('detectLinks', v)} />
        {MAC && <Toggle label={t.g_linksBg} hint={t.g_linksBgHint} on={s.linksInBackground} set={(v) => set('linksInBackground', v)} />}
      </Group>
      <Group title={t.sec_swipe} note={t.sec_swipeNote}>
        <Line label={t.swipeLeft}><Choice value={s.swipeLeft} onChange={(v) => set('swipeLeft', v)} options={swipes} /></Line>
        <Line label={t.swipeRight}><Choice value={s.swipeRight} onChange={(v) => set('swipeRight', v)} options={swipes} /></Line>
      </Group>
      <Group title={t.sec_attachments}>
        <Line label={t.g_downloads}>
          <span className="muted small ellipsis dl-name" title={s.downloadsFolder}>{s.downloadsFolder ? folderName : t.g_askEachTime}</span>
          <button className="pill small" onClick={() => window.roarmail.pickFolder().then((p) => { if (p) set('downloadsFolder', p) })}>{t.g_choose}</button>
          {s.downloadsFolder && <button className="pill small ghost" onClick={() => set('downloadsFolder', '')}>{t.g_askEachTime}</button>}
        </Line>
      </Group>
    </div>
  )
}

/** Mail > Composing: sending */
function Composing({ s, set }: { s: Settings; set: Set }) {
  return (
    <div className="stack">
      <Group title={t.sec_sending}>
        <Line label={t.undoSend}>
          <Choice value={s.undoSendSeconds} onChange={(v) => set('undoSendSeconds', v)} options={[0, 5, 10, 20, 30].map((n) => [n, n ? `${n} ${t.seconds}` : t.off])} />
        </Line>
        <Toggle label={t.g_retry} hint={t.g_retryHint} on={s.retrySending} set={(v) => set('retrySending', v)} />
      </Group>
      <p className="muted small set-note">{t.sec_composeNote}</p>
    </div>
  )
}

/** Mail > Notifications: what tells you about new mail */
function Notify({ s, set }: { s: Settings; set: Set }) {
  return (
    <div className="stack">
      <Group title={t.sec_notifications}>
        <Line label={t.g_notify}>
          <Choice value={s.notifyFor} onChange={(v) => set('notifyFor', v)} options={[['inbox', t.g_notifyInbox], ['known', t.g_notifyKnown], ['none', t.g_notifyNone]]} />
        </Line>
        {MAC && s.notifyFor !== 'none' && <Toggle label={t.g_notifyReply} hint={t.g_notifyReplyHint} on={s.notifyReply} set={(v) => set('notifyReply', v)} />}
      </Group>
      <Group title={t.sec_sounds}>
        <Line label={t.g_sound}>
          <select value={s.newMailSound} onChange={(e) => { const v = e.target.value as Settings['newMailSound']; set('newMailSound', v); if (v !== 'system' && v !== 'none') playNewMail(v) }}>
            <option value="system">{t.g_soundSystem}</option>
            {NEW_MAIL_SOUNDS.map((k) => <option key={k} value={k}>{t[`snd_${k}` as Key]}</option>)}
            <option value="none">{t.g_soundNone}</option>
          </select>
          <button className="tool small" title={t.g_play} disabled={s.newMailSound === 'system' || s.newMailSound === 'none'} onClick={() => playNewMail(s.newMailSound as NewMailSound)}><Icon name="bell" size={15} /></button>
        </Line>
        <Toggle label={t.g_actionSounds} hint={t.g_actionSoundsHint} on={s.actionSounds} set={(v) => set('actionSounds', v)} />
      </Group>
      <Group title={t.sec_badges}>
        <Line label={t.g_badge}>
          <Choice value={s.dockBadge} onChange={(v) => set('dockBadge', v)} options={[['inbox', t.g_badgeInbox], ['all', t.g_badgeAll], ['none', t.g_badgeNone]]} />
        </Line>
        <Toggle label={t.ap_accBadges} hint={t.ap_accBadgesHint} on={s.accountBadges} set={(v) => set('accountBadges', v)} />
      </Group>
    </div>
  )
}

/** Mail > Search */
function Search({ s, set }: { s: Settings; set: Set }) {
  return (
    <div className="stack">
      <Group title={t.sec_searchWhere}>
        <Toggle label={t.ad_searchSpam} on={s.searchJunk} set={(v) => set('searchJunk', v)} />
        <Toggle label={t.ad_searchTrash} on={s.searchTrash} set={(v) => set('searchTrash', v)} />
        <Toggle label={t.ad_online} hint={t.ad_onlineHint} on={s.onlineSearch} set={(v) => set('onlineSearch', v)} />
      </Group>
      <Group title={t.sec_searchHow} note={t.ad_accentsNote}>
        <Toggle label={t.ad_conversations} hint={t.ad_conversationsHint} on={s.searchConversations} set={(v) => set('searchConversations', v)} />
        <Toggle label={t.ad_exact} hint={t.ad_exactHint} on={s.exactSearch} set={(v) => set('exactSearch', v)} />
      </Group>
    </div>
  )
}

/** Look > Theme: RoarMe's look settings */
function Theme({ s, set }: { s: Settings; set: Set }) {
  const modes: [Settings['appearance'], string][] = [['system', t.ap_auto], ['dark', t.ap_dark], ['light', t.ap_light]]
  const dens: [Settings['density'], string][] = [['relaxed', t.den_relaxed], ['standard', t.den_standard], ['tight', t.den_tight]]
  const themeSeg = useLens<HTMLDivElement>(s.theme)
  const modeSeg = useLens<HTMLDivElement>(s.appearance)
  const denSeg = useLens<HTMLDivElement>(s.density)
  return (
    <div className="stack">
      <div className="set-preview">
        <div className="msg on"><div className="avatar" style={{ background: 'hsl(20 45% 38%)' }}>ΜΠ</div>
          <div className="msg-body"><div className="row"><i className="dot" /><b className="grow">Μαρία Παπαδοπούλου</b><span className="count">2</span><span className="muted small">10:24</span></div>
            <div className="subj">{t.previewSubject}</div><div className="snip muted">{t.previewText}</div></div></div>
        <div className="row"><button className="pill primary small">{t.send}</button><button className="pill small">{t.reply}</button></div>
      </div>
      <Group title={t.sec_colours}>
        <Line label={t.theme}>
          <div className="theme-tiles seg lens" ref={themeSeg}>
            {(['simba', 'pumba'] as const).map((th) => (
              <button key={th} className={`theme-tile ${th} ${s.theme === th ? 'on' : ''}`} onClick={(e) => set('theme', th, e)}>
                <i className="tile-art" /><span>{th === 'simba' ? 'Simba' : 'Pumba'}</span>
              </button>
            ))}
          </div>
        </Line>
        <Line label={t.dayNight}>
          <div className="seg lens" ref={modeSeg}>
            {modes.map(([k, label]) => <button key={k} className={s.appearance === k ? 'on' : ''} onClick={(e) => set('appearance', k, e)}>{label}</button>)}
          </div>
        </Line>
        <Line label={t.accent}>
          <div className="accents">
            <button className={`accent-dot theme-own ${!s.accent ? 'on' : ''}`} title={t.themeColor} onClick={() => set('accent', '')} />
            {ACCENTS.map(([k, label, hex]) => (
              <button key={k} className={`accent-dot ${s.accent === k ? 'on' : ''} ${k === 'white' ? 'white' : ''}`} title={label} style={{ ['--c' as any]: hex }} onClick={() => set('accent', k)} />
            ))}
          </div>
        </Line>
      </Group>
      <Group title={t.sec_shape}>
        <Line label={t.font}>
          <select value={s.font} onChange={(e) => set('font', e.target.value as Settings['font'])}>
            {FONTS.map(([k, label, fam]) => <option key={k} value={k} style={{ fontFamily: fam }}>{label}</option>)}
          </select>
        </Line>
        <Line label={t.density}>
          <div className="seg lens" ref={denSeg}>
            {dens.map(([k, label]) => <button key={k} className={s.density === k ? 'on' : ''} onClick={() => set('density', k)}>{label}</button>)}
          </div>
        </Line>
        <Line label={<>{t.corners} <b className="muted">{s.radius}px</b></>}>
          <input type="range" min={4} max={16} step={2} value={s.radius} onChange={(e) => set('radius', Number(e.target.value))} />
        </Line>
        <Line label={<>{t.textSize} <b className="muted">{TEXT_SIZES[s.textSize]}px</b></>}>
          <input type="range" min={0} max={4} step={1} value={s.textSize} onChange={(e) => set('textSize', Number(e.target.value))} />
        </Line>
      </Group>
      <Group title={t.ap_feel}>
        <Toggle label={t.motion} hint={t.motionHint} on={s.motion} set={(v) => set('motion', v)} />
        <Toggle label={t.glassLook} hint={t.glassHint} on={s.glass} set={(v) => set('glass', v)} />
        <Toggle label={t.focusRings} hint={t.focusHint} on={s.focusRings} set={(v) => set('focusRings', v)} />
        <Toggle label={t.lite} hint={t.liteHint} on={s.lite} set={(v) => set('lite', v)} />
      </Group>
    </div>
  )
}

/** Look > Message list: what each row shows, pictures, colours and counters */
function ListPage({ s, set }: { s: Settings; set: Set }) {
  const counters: [Settings['inboxCounter'], string][] = [['unread', t.ap_cUnread], ['total', t.ap_cTotal], ['none', t.ap_cNone]]
  return (
    <div className="stack">
      <Group title={t.sec_rows}>
        <Line label={t.ap_preview}>
          <Choice value={s.previewLines} onChange={(v) => set('previewLines', v)} options={[[0, t.ap_previewNone], [1, t.ap_preview1], [2, t.ap_preview2], [3, t.ap_preview3]]} />
        </Line>
        <Toggle label={t.ap_avatars} hint={t.ap_avatarsHint} on={s.listAvatars} set={(v) => set('listAvatars', v)} />
        <Toggle label={t.ap_senderPics} hint={s.privacyMode ? t.ap_senderPicsOff : t.ap_senderPicsHint} on={s.senderPictures && !s.privacyMode} disabled={s.privacyMode || !s.listAvatars} set={(v) => set('senderPictures', v)} />
        <Toggle label={t.ap_accColours} hint={t.ap_accColoursHint} on={s.accountColours} set={(v) => set('accountColours', v)} />
      </Group>
      <Group title={t.sec_thread}>
        <Line label={t.ap_threadOrder}>
          <Choice value={s.threadOrder} onChange={(v) => set('threadOrder', v)} options={[['oldest', t.ap_oldestFirst], ['newest', t.ap_newestFirst]] as [Settings['threadOrder'], string][]} />
        </Line>
      </Group>
      <Group title={t.sec_counters}>
        <Line label={t.ap_inboxCounter}><Choice value={s.inboxCounter} onChange={(v) => set('inboxCounter', v)} options={counters} /></Line>
        <Line label={t.ap_folderCounter}><Choice value={s.folderCounter} onChange={(v) => set('folderCounter', v)} options={counters} /></Line>
      </Group>
    </div>
  )
}

export function Toggle({ label, hint, on, set, disabled }: { label: string; hint?: string; on: boolean; set: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`toggle ${disabled ? 'off' : ''}`}>
      <span className="grow"><b>{label}</b>{hint && <small className="muted">{hint}</small>}</span>
      <span className="switch"><input type="checkbox" checked={on} disabled={disabled} onChange={(e) => set(e.target.checked)} /><i /></span>
    </label>
  )
}

function Shortcuts() {
  const rows: [string, Key][] = [
    ['C', 'compose'], ['R', 'reply'], ['A', 'replyAll'], ['F', 'forward'], ['E', 'archiveIt'], ['#', 'trashIt'], ['M', 'moveTo'],
    ['B', 'snoozeIt'], ['S', 'flag'], ['U', 'markUnread'], ['Z', 'undo'], ['/', 'search'], ['J / ↓', 'nextMsg'], ['K / ↑', 'prevMsg'],
    ['⌘A', 'selectAll'], ['⌘↵', 'send'], ['Esc', 'cancel'],
  ]
  return (
    <div className="keys">
      {rows.map(([k, label]) => <div className="key-row" key={k}><kbd>{k}</kbd><span>{t[label]}</span></div>)}
    </div>
  )
}

function Accounts({ sigs, onAdd }: { accounts: Account[]; sigs: Signature[]; onAdd: () => void }) {
  // every account, the switched-off ones too, kept fresh while the page is open
  const [all, setAll] = useState<Account[]>([])
  const [pick, setPick] = useState('')
  useEffect(() => {
    const load = () => window.roarmail.allAccounts().then(setAll)
    load()
    return window.roarmail.on((e) => { if (e.type === 'accounts') load() })
  }, [])
  const a = all.find((x) => x.id === pick) || all[0]
  return (
    <div className="stack">
      <div className="acct-pick">
        {all.map((x) => (
          <button key={x.id} className={`acct-chip ${x.id === a?.id ? 'on' : ''} ${x.enabled ? '' : 'disabled'}`} onClick={() => setPick(x.id)} title={x.email}>
            <span className="acc-dot" style={{ background: x.color }} />
            <span className="ellipsis">{x.description || x.email}</span>
          </button>
        ))}
        <button className="acct-chip add" onClick={onAdd} title={t.addAccount}><Icon name="plus" size={14} /></button>
      </div>
      {a && <AccountDetail key={a.id} a={a} sigs={sigs} />}
    </div>
  )
}

type AccTab = 'info' | 'folders' | 'server'

function AccountDetail({ a, sigs }: { a: Account; sigs: Signature[] }) {
  const [tab, setTab] = useState<AccTab>('info')
  const seg = useLens<HTMLDivElement>(tab)
  const tabs: [AccTab, string][] = [['info', t.ac_info], ['folders', t.ac_folders], ['server', t.ac_server]]
  return (
    <div className="panel acct-detail">
      <div className="row">
        <span className="acc-dot big" style={{ background: a.color }} />
        <span className="grow"><b className="ellipsis">{a.email}</b>
          <span className={`muted small state ${a.state}`}>{a.enabled ? t[a.state as Key] || '' : t.ac_off}</span></span>
        <div className="seg lens" ref={seg}>
          {tabs.map(([k, label]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
        </div>
      </div>
      {tab === 'info' && <AccountInfo a={a} sigs={sigs} />}
      {tab === 'folders' && <AccountFolders a={a} />}
      {tab === 'server' && <AccountServer a={a} />}
    </div>
  )
}

function AccountInfo({ a, sigs }: { a: Account; sigs: Signature[] }) {
  const [name, setName] = useState(a.displayName)
  const [desc, setDesc] = useState(a.description)
  const [alias, setAlias] = useState({ email: '', name: '' })
  const [error, setError] = useState('')
  const up = (patch: Parameters<typeof window.roarmail.updateAccount>[1]) => window.roarmail.updateAccount(a.id, patch)
  const addAlias = async () => {
    setError('')
    try { await window.roarmail.addAlias(a.id, alias.email, alias.name); setAlias({ email: '', name: '' }) } catch { setError(t.ac_badAlias) }
  }
  return (
    <>
      <div className="row avatar-row">
        <span className="acc big-acc" style={{ ['--c' as any]: a.color, background: a.color }}>
          {a.avatar ? <img className="acc-img" src={a.avatar} alt="" /> : (a.description || a.displayName || a.email).slice(0, 2).toUpperCase()}
        </span>
        <div className="grow"><b>{t.ac_picture}</b><small className="muted block">{t.ac_pictureHint}</small></div>
        <button className="pill small" onClick={() => window.roarmail.pickAvatar(a.id).catch(() => setError(t.ac_badPicture))}>{a.avatar ? t.ac_pictureChange : t.ac_pictureAdd}</button>
        {a.avatar && <button className="pill small ghost" onClick={() => up({ avatar: null })}>{t.delete}</button>}
      </div>
      <Toggle label={t.ac_enabled} hint={t.ac_enabledHint} on={a.enabled} set={(v) => up({ enabled: v })} />
      <div className="row two">
        <label className="grow">{t.ac_description}
          <input value={desc} placeholder={a.email} onChange={(e) => setDesc(e.target.value)} onBlur={() => desc !== a.description && up({ description: desc })} />
        </label>
        <label className="grow">{t.name}
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== a.displayName && up({ displayName: name.trim() })} />
        </label>
      </div>
      <div className="row wrap">
        <span className="muted small label-w">{t.color}</span>
        {COLORS.map((c) => <button key={c} className={`swatch ${a.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => up({ color: c })} />)}
      </div>
      <label>{t.signature}
        <select value={a.signatureId || ''} onChange={(e) => up({ signatureId: e.target.value || null })}>
          <option value="">{t.noSignature}</option>
          {sigs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>
      <label>{t.ac_attachments}
        <select value={a.attachments} onChange={(e) => up({ attachments: e.target.value as Account['attachments'] })}>
          <option value="all">{t.ac_att_all}</option>
          <option value="recent">{t.ac_att_recent}</option>
          <option value="none">{t.ac_att_none}</option>
        </select>
      </label>

      <div className="aliases">
        <b>{t.ac_aliases}</b>
        <p className="muted small">{t.ac_aliasesHint}</p>
        {a.aliases.map((x) => (
          <div className="row blocked-row" key={x.id}>
            <span className="grow ellipsis">{x.name ? `${x.name} <${x.email}>` : x.email}</span>
            <button className="pill small ghost" onClick={() => window.roarmail.removeAlias(x.id)}>{t.delete}</button>
          </div>
        ))}
        <div className="row">
          <input className="grow" placeholder={t.ac_aliasEmail} value={alias.email} onChange={(e) => setAlias({ ...alias, email: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') addAlias() }} />
          <input className="grow" placeholder={t.ac_aliasName} value={alias.name} onChange={(e) => setAlias({ ...alias, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') addAlias() }} />
          <button className="pill small" disabled={!alias.email.trim()} onClick={addAlias}><Icon name="plus" size={13} /> {t.ac_addAlias}</button>
        </div>
        {error && <p className="error small">{error}</p>}
      </div>

      <div className="row end">
        <button className="pill small ghost danger" onClick={() => { if (confirm(`${t.removeQ}\n\n${a.email}`)) window.roarmail.removeAccount(a.id) }}>{t.removeAccount}</button>
      </div>
    </>
  )
}

const ROLE_ROWS: [keyof Account['roles'], Key][] = [['drafts', 'drafts'], ['sent', 'sent'], ['spam', 'spam'], ['trash', 'trash'], ['archive', 'archive']]
const ERASE_DAYS = [0, 1, 7, 30, 90]

/** Apple Mail's "Mailbox Behaviours": which folder is which, and erasing old Trash and Junk */
function AccountFolders({ a }: { a: Account }) {
  const [list, setList] = useState<{ path: string; name: string }[]>([])
  const [hidden, setHidden] = useState<Folder[]>([])
  const loadHidden = () => window.roarmail.hiddenFolders(a.id).then(setHidden)
  useEffect(() => { window.roarmail.serverFolders(a.id).then(setList); loadHidden() }, [a.id])
  const days = (n: number) => (n === 0 ? t.ac_never : n === 1 ? `1 ${t.day}` : `${n} ${t.days}`)
  return (
    <>
      <p className="muted small">{t.ac_foldersHint}</p>
      {ROLE_ROWS.map(([role, label]) => (
        <div className="set-row" key={role}><span>{t[label]}</span>
          <select value={a.roles[role] || ''} onChange={(e) => window.roarmail.updateAccount(a.id, { roles: { ...a.roles, [role]: e.target.value } })}>
            <option value="">{t.ac_serverChoice}</option>
            {list.map((f) => <option key={f.path} value={f.path}>{f.path}</option>)}
          </select>
        </div>
      ))}
      <div className="set-row"><span>{t.ac_eraseTrash}</span>
        <select value={a.trashDays} onChange={(e) => window.roarmail.updateAccount(a.id, { trashDays: Number(e.target.value) })}>
          {ERASE_DAYS.map((n) => <option key={n} value={n}>{days(n)}</option>)}
        </select>
      </div>
      <div className="set-row"><span>{t.ac_eraseJunk}</span>
        <select value={a.junkDays} onChange={(e) => window.roarmail.updateAccount(a.id, { junkDays: Number(e.target.value) })}>
          {ERASE_DAYS.map((n) => <option key={n} value={n}>{days(n)}</option>)}
        </select>
      </div>
      {hidden.length > 0 && <h4 className="set-sub">{t.ac_hiddenFolders}</h4>}
      {hidden.map((f) => (
        <div className="set-row" key={f.id}><span>{f.path}</span>
          <button className="pill small" onClick={async () => { await window.roarmail.hideFolder(f.id, false); loadHidden() }}>{t.ac_show}</button>
        </div>
      ))}
    </>
  )
}

/** Apple Mail's "Server Settings": tested before they are kept */
function AccountServer({ a }: { a: Account }) {
  const [c, setC] = useState({ imapHost: a.imapHost, imapPort: a.imapPort, imapTls: a.imapTls, smtpHost: a.smtpHost, smtpPort: a.smtpPort, smtpTls: a.smtpTls, username: a.username })
  const [pass, setPass] = useState('')
  const [state, setState] = useState<{ busy?: boolean; ok?: boolean; error?: string }>({})
  const changed = pass || (Object.keys(c) as (keyof typeof c)[]).some((k) => c[k] !== a[k])
  const save = async () => {
    setState({ busy: true })
    const r = await window.roarmail.updateServer(a.id, { ...c, email: a.email, displayName: a.displayName, provider: a.provider }, pass || undefined)
    setState(r.ok ? { ok: true } : { error: t[`err_${r.error}` as Key] || r.error })
    if (r.ok) setPass('')
  }
  const tls = (v: Tls, set: (v: Tls) => void) => (
    <select value={v} onChange={(e) => set(e.target.value as Tls)}>
      <option value="tls">SSL/TLS</option><option value="starttls">STARTTLS</option><option value="none">{t.ac_noTls}</option>
    </select>
  )
  return (
    <>
      <b className="small muted">{t.ac_incoming}</b>
      <div className="row two">
        <label className="grow">{t.ac_host}<input value={c.imapHost} onChange={(e) => setC({ ...c, imapHost: e.target.value.trim() })} /></label>
        <label className="port">{t.ac_port}<input type="number" value={c.imapPort} onChange={(e) => setC({ ...c, imapPort: Number(e.target.value) })} /></label>
        <label>{t.ac_security}{tls(c.imapTls, (v) => setC({ ...c, imapTls: v }))}</label>
      </div>
      <b className="small muted">{t.ac_outgoing}</b>
      <div className="row two">
        <label className="grow">{t.ac_host}<input value={c.smtpHost} onChange={(e) => setC({ ...c, smtpHost: e.target.value.trim() })} /></label>
        <label className="port">{t.ac_port}<input type="number" value={c.smtpPort} onChange={(e) => setC({ ...c, smtpPort: Number(e.target.value) })} /></label>
        <label>{t.ac_security}{tls(c.smtpTls, (v) => setC({ ...c, smtpTls: v }))}</label>
      </div>
      <div className="row two">
        <label className="grow">{t.ac_username}<input value={c.username} onChange={(e) => setC({ ...c, username: e.target.value.trim() })} /></label>
        <label className="grow">{t.ac_password}<input type="password" value={pass} placeholder={t.ac_passwordKeep} onChange={(e) => setPass(e.target.value)} /></label>
      </div>
      <div className="row end">
        {state.ok && <span className="small ok-text">{t.ac_serverSaved}</span>}
        {state.error && <span className="small error">{state.error}</span>}
        <button className="pill small primary" disabled={!changed || state.busy} onClick={save}>{state.busy ? t.ac_testing : t.ac_testSave}</button>
      </div>
    </>
  )
}

function Signatures({ sigs, reload }: { sigs: Signature[]; reload: () => void }) {
  const [editing, setEditing] = useState<string | null>(sigs[0]?.id || null)
  const current = sigs.find((s) => s.id === editing)
  return (
    <div className="sig-layout">
      <div className="sig-list">
        {sigs.map((s) => <button key={s.id} className={`folder ${s.id === editing ? 'on' : ''}`} onClick={() => setEditing(s.id)}><span className="grow ellipsis">{s.name}</span></button>)}
        <button className="pill small" onClick={async () => { const s = await window.roarmail.saveSignature({ id: '', name: t.newSignature, html: '' }); await reload(); setEditing(s.id) }}>
          <Icon name="plus" size={13} /> {t.newSignature}
        </button>
      </div>
      {current ? <SignatureEditor key={current.id} sig={current} reload={reload} onDeleted={() => setEditing(null)} /> : <div className="muted sig-empty">{t.signatures}</div>}
    </div>
  )
}

function SignatureEditor({ sig, reload, onDeleted }: { sig: Signature; reload: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(sig.name)
  const [saved, setSaved] = useState(false)
  const ed = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ed.current) ed.current.innerHTML = DOMPurify.sanitize(sig.html) }, [])
  const save = async () => {
    await window.roarmail.saveSignature({ id: sig.id, name: name.trim() || t.signature, html: DOMPurify.sanitize(ed.current?.innerHTML || '') })
    reload(); setSaved(true); setTimeout(() => setSaved(false), 1500)
  }
  return (
    <div className="sig-edit">
      <label>{t.signatureName}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div className="editor sig" ref={ed} contentEditable suppressContentEditableWarning />
      <div className="row end">
        <button className="pill small ghost danger" onClick={async () => { await window.roarmail.deleteSignature(sig.id); reload(); onDeleted() }}>{t.delete}</button>
        <button className="pill small primary" onClick={save}>{saved ? t.saved : t.save}</button>
      </div>
    </div>
  )
}

/** the updater's state, live (the desktop app only; the web has none) */
function useUpdate() {
  const [u, setU] = useState<UpdateState | null>(null)
  useEffect(() => {
    const api = (window.roarmail as any).update
    if (!api) return undefined
    api.state().then(setU).catch(() => {})
    return api.on(setU)
  }, [])
  return u
}

/** System > Updates: this version, a Check now button, what the updater is doing, and updating by itself */
function Updates({ s, set }: { s: Settings; set: Set }) {
  const u = useUpdate()
  const api = (window.roarmail as any).update
  const since = u?.checkedAt ? when(u.checkedAt) : ''
  const line = !u ? t.up_noUpdater
    : u.status === 'checking' ? t.up_checking
    : u.status === 'downloading' ? `${t.up_downloading} ${u.version} · ${u.progress}%`
    : u.status === 'ready' ? `${t.up_ready} ${u.version}`
    : u.status === 'installing' ? t.up_installing
    : u.status === 'error' ? `${t.up_error} (${u.error})`
    : u.error === 'dev' ? t.up_dev
    : u.checkedAt ? `${t.up_latest} · ${t.up_checked} ${since}` : ''
  return (
    <div className="stack">
      <div className="panel update-panel">
        <div className="row">
          <div className="brand"><b>ROAR</b><i>MAIL</i></div>
          <span className="grow" />
          <b className="muted">{u?.current ? `${t.up_version} ${u.current}` : ''}</b>
        </div>
        {u?.status === 'downloading' && <div className="update-bar"><i style={{ width: `${u.progress}%` }} /></div>}
        <p className={`small ${u?.status === 'error' ? 'error' : u?.status === 'ready' ? 'ok-text' : 'muted'}`}>{line}</p>
        <div className="row end">
          {u?.status === 'ready'
            ? <button className="pill primary" onClick={() => api.install()}>{t.up_restart}</button>
            : <button className="pill" disabled={!api || u?.status === 'checking' || u?.status === 'downloading'} onClick={() => api.check()}>
                <Icon name="refresh" size={14} /> {t.up_check}</button>}
        </div>
      </div>
      <Group note={t.up_how}>
        <Toggle label={t.up_auto} hint={t.up_autoHint} on={s.autoUpdate} set={(v) => set('autoUpdate', v)} />
      </Group>
      {/* Privacy Policy and Terms (Alex, 25 Oct): on the company site, opened in the browser */}
      <div className="row legal-links">
        {([['privacy', t.lg_privacy], ['terms', t.lg_terms]] as const).map(([at, label]) => (
          <button key={at} className="pill" onClick={() => window.roarmail.openExternal(`https://themadlions.com/legal/roarmail/${lang === 'el' ? '?lang=el' : ''}#${at}`)}>{label}</button>))}
      </div>
    </div>
  )
}

/** System > Advanced: the resets */
function Advanced({ replace }: { replace: (s: Settings) => void }) {
  const [note, setNote] = useState('')
  const mb = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`)
  return (
    <div className="stack">
      <Group title={t.ad_reset}>
        <Line label={t.ad_clearCache} hint={t.ad_clearCacheHint}>
          <button className="pill small" onClick={async () => setNote(`${t.ad_freed} ${mb(await window.roarmail.clearCache())}`)}>{t.ad_clear}</button>
        </Line>
        <Line label={t.ad_resetSettings} hint={t.ad_resetHint}>
          <button className="pill small ghost danger" onClick={async () => {
            if (!confirm(t.ad_resetQ)) return
            await window.roarmail.resetSettings()
            replace(await window.roarmail.settings()); setNote(t.ad_resetDone)
          }}>{t.ad_resetBtn}</button>
        </Line>
      </Group>
      {note && <p className="small ok-text">{note}</p>}
    </div>
  )
}

const QUOTE_COLORS: [string, Key][] = [
  ['#6d5dfc', 'qc_purple'], ['#1fa3b8', 'qc_teal'], ['#3fae49', 'qc_green'], ['#2f7bff', 'qc_blue'],
  ['#e0413a', 'qc_red'], ['#f08a24', 'qc_orange'], ['#e5489b', 'qc_pink'], ['#8a8f98', 'qc_grey'],
]

/** Apple Mail's "Fonts & Colours": the list, messages and fixed width; quoted text coloured by level */
function Fonts({ s, set }: { s: Settings; set: Set }) {
  const [local, setLocal] = useState<string[] | null>(null)
  const [noLocal, setNoLocal] = useState(false)
  // the fonts installed on this computer (Cera GR and the rest), asked for when the person wants them
  const loadLocal = async () => {
    try {
      const q = (window as any).queryLocalFonts as undefined | (() => Promise<{ family: string }[]>)
      if (!q) throw new Error('none')
      const fams = [...new Set((await q()).map((f) => f.family))].sort((x, y) => x.localeCompare(y))
      if (!fams.length) throw new Error('none')
      setLocal(fams)
    } catch { setNoLocal(true) }
  }
  const picker = (k: 'listFont' | 'messageFont' | 'monoFont') => (
    <select value={s[k]} style={{ fontFamily: fontStack(s[k]) }} onChange={(e) => set(k, e.target.value)}>
      <optgroup label="RoarMail">
        {FONTS.map(([key, label, fam]) => <option key={key} value={key} style={{ fontFamily: fam }}>{label}</option>)}
      </optgroup>
      {(local || (s[k].startsWith('local:') ? [s[k].slice(6)] : [])).length > 0 && (
        <optgroup label={t.f_computer}>
          {(local || [s[k].slice(6)]).map((f) => <option key={f} value={`local:${f}`} style={{ fontFamily: `"${f}"` }}>{f}</option>)}
        </optgroup>
      )}
    </select>
  )
  const levels: ['quote1' | 'quote2' | 'quote3', Key][] = [['quote1', 'f_level1'], ['quote2', 'f_level2'], ['quote3', 'f_level3']]
  return (
    <div className="stack">
      <Group title={t.sec_fonts} note={local ? undefined : noLocal ? t.f_noComputer : undefined}>
        <Line label={t.f_list}>
          {picker('listFont')}
          <Choice value={s.listSize} onChange={(v) => set('listSize', v)} options={[12, 13, 14, 15, 16, 18].map((n) => [n, String(n)])} />
        </Line>
        <Line label={t.f_message}>
          {picker('messageFont')}
          <Choice value={s.textSize} onChange={(v) => set('textSize', v)} options={TEXT_SIZES.map((n, i) => [i, String(n)])} />
        </Line>
        <Line label={t.f_mono}>{picker('monoFont')}</Line>
        {!local && !noLocal && <Line label={<span className="muted">{t.f_computerHint}</span>}><button className="pill small" onClick={loadLocal}>{t.f_showComputer}</button></Line>}
        <Toggle label={t.f_plainMono} on={s.plainMono} set={(v) => set('plainMono', v)} />
      </Group>
      <Group title={t.sec_quotes}>
        <Toggle label={t.f_quoteColors} on={s.quoteColors} set={(v) => set('quoteColors', v)} />
        {s.quoteColors && (
          <div className="quote-set">
            <div className="quote-levels">
              {levels.map(([k, label]) => (
                <div className="row" key={k}>
                  <span className="muted small label-w">{t[label]}</span>
                  {QUOTE_COLORS.map(([hex, name]) => (
                    <button key={hex} className={`swatch ${s[k] === hex ? 'on' : ''}`} title={t[name]} style={{ background: hex }} onClick={() => set(k, hex)} />
                  ))}
                </div>
              ))}
            </div>
            <div className="quote-preview" style={{ fontFamily: fontStack(s.messageFont) }}>
              <div style={{ borderColor: s.quote1, color: s.quote1 }}>{t.f_level1}
                <div style={{ borderColor: s.quote2, color: s.quote2 }}>{t.f_level2}
                  <div style={{ borderColor: s.quote3, color: s.quote3 }}>{t.f_level3}</div>
                </div>
              </div>
            </div>
          </div>
        )}
      </Group>
    </div>
  )
}

/** Privacy: privacy mode first, then the single switches, the lock and blocked senders */
function Privacy({ s, set }: { s: Settings; set: Set }) {
  const [lock, setLock] = useState<LockState | null>(null)
  const [blocked, setBlocked] = useState<string[]>([])
  useEffect(() => {
    window.roarmail.lockState().then(setLock)
    window.roarmail.blockedSenders().then(setBlocked)
  }, [])
  return (
    <div className="stack">
      <Group>
        <Toggle label={t.ad_privacy} hint={t.ad_privacyHint} on={s.privacyMode} set={(v) => set('privacyMode', v)} />
      </Group>
      <Group title={t.sec_trackers}>
        <Toggle label={t.blockTrackersShort} hint={t.blockTrackers} on={s.blockTrackers || s.privacyMode} disabled={s.privacyMode} set={(v) => set('blockTrackers', v)} />
        <Toggle label={t.stripTrackingShort} hint={t.stripTracking} on={s.stripTracking || s.privacyMode} disabled={s.privacyMode} set={(v) => set('stripTracking', v)} />
      </Group>
      <Group title={t.sec_lock} note={lock && !lock.available ? t.lockUnavailable : undefined}>
        <Toggle label={t.appLock} disabled={!lock?.available} on={!!(s.lock && lock?.available)} set={(v) => set('lock', v)} />
        {lock?.available && s.lock && (
          <Line label={t.lockAfter}>
            <Choice value={s.lockAfter} onChange={(v) => set('lockAfter', v)} options={[0, 1, 5, 15, 60].map((n) => [n, n ? `${n} ${t.minutes}` : t.onlySleep])} />
            <button className="pill small" onClick={() => window.roarmail.lockNow()}>{t.lockNow}</button>
          </Line>
        )}
      </Group>
      <Group title={t.blockedSenders} note={!blocked.length ? t.noneBlocked : undefined}>
        {blocked.map((e) => (
          <Line key={e} label={<span className="ellipsis">{e}</span>}>
            <button className="pill small ghost" onClick={async () => { await window.roarmail.blockSender(e, false); setBlocked(blocked.filter((x) => x !== e)) }}>{t.unblock}</button>
          </Line>
        ))}
      </Group>
    </div>
  )
}
