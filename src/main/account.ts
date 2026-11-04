// RoarMail and the Roar Account (Alex, 3 Nov 2026: one account for every Roar app, like iCloud; it is RoarMe's sign-in).
// Two things ride on it here:
// - Sync: RoarMail's setup (settings, signatures, templates, rules, blocks, account and folder settings, the contacts
//   marked by hand) kept in the account (roarmail_sync), so another computer gets it by signing in. Never mail, never
//   a mail password or token. Checked every minute: a newer copy from another computer comes in, a change here goes up.
// - AI: the ✦ button in a new message. Through the Roar Account (Edge Function roarmail-ai, a daily allowance), or with
//   the person's own Claude or ChatGPT key, kept encrypted on this computer and sent only to that company.
import { app, net, safeStorage } from 'electron'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { MailService, SetupBundle } from './mail'
import type { RoarMe } from './roarme'
import type { AiProvider, AiStatus, Invite, SyncState } from '../shared/api'
import { AI_SYSTEM, aiPrompt, type AiRequest } from '../shared/aiPrompt'

const FN = 'https://bzmjhbnwhdwmncxkqkdl.supabase.co/functions/v1/roarmail-ai'
const KEY = 'sb_publishable_7mQ3e0NH5lCmdoIKx2-FUA_EgCoXx9X'
const EVERY = 60e3

/** the bundle without what changes on its own, as a fingerprint: only a real change goes up */
const printOf = (b: SetupBundle) => createHash('sha256').update(JSON.stringify(b.tables)).digest('hex')

export class RoarAccount {
  private timer: ReturnType<typeof setInterval> | null = null
  private busy = false
  private lastPrint = ''
  private state: SyncState = { on: false, signedIn: false, at: 0, error: '' }
  private devicesAt = 0

  constructor(private mail: MailService, private roarme: RoarMe, private emit: () => void) {}

  start() {
    if (this.timer) return
    setTimeout(() => this.tick().catch(() => {}), 8e3)
    this.timer = setInterval(() => this.tick().catch(() => {}), EVERY)
  }

  syncState(): SyncState { return { ...this.state, on: this.mail.settings().syncSetup } }

  private set(patch: Partial<SyncState>) { this.state = { ...this.state, ...patch }; this.emit() }

  /** a sign-in or sign-out, or the switch: check at once */
  nudge() { this.lastPrint = ''; this.tick().catch(() => {}) }

  async syncNow(): Promise<SyncState> { this.lastPrint = ''; await this.tick(true); return this.syncState() }

  private local(key: string) { return this.mail.localValue(key) }
  private setLocal(key: string, v: string) { this.mail.setLocalValue(key, v) }

  /** the Roar Account's projects with RoarMail senders (3 Nov 2026), for the Projects in the side list */
  private async projects() {
    const acc = await this.roarme.account().catch(() => null)
    if (!acc) { this.mail.setRoarProjects([]); return }
    const [{ data: ps }, { data: its }] = await Promise.all([
      acc.sb.from('roar_projects').select('id, name, color, archived').order('updated_at', { ascending: false }),
      acc.sb.from('roar_project_items').select('project_id, item_id').eq('app', 'roarmail').eq('kind', 'sender'),
    ])
    if (!ps) return
    this.mail.setRoarProjects(ps.filter((p: any) => !p.archived).map((p: any) => ({ id: p.id, name: p.name, color: p.color || '#ff3b2f',
      senders: (its || []).filter((i: any) => i.project_id === p.id).map((i: any) => String(i.item_id)) })).filter((p) => p.senders.length))
  }

  /** an invitation answered in RoarMail goes into the Roar Calendar (source roarmail, one row per invitation) */
  async inviteToCalendar(inv: Invite, answer: string) {
    const acc = await this.roarme.account()
    if (!acc || !inv?.uid || !inv.start) return
    if (answer === 'declined') {
      await acc.sb.from('roar_calendar_events').update({ deleted_at: new Date().toISOString() }).eq('owner', acc.userId).eq('source', 'roarmail').eq('source_id', inv.uid)
      return
    }
    const row = { title: (answer === 'tentative' ? '? ' : '') + (inv.title || 'Meeting'),
      starts_at: new Date(inv.start).toISOString(), ends_at: inv.end ? new Date(inv.end).toISOString() : null, all_day: !!inv.allDay,
      location: inv.location || null, notes: inv.organizer ? `From ${inv.organizer.name || inv.organizer.address}` : null, deleted_at: null }
    // the unique index is partial (source_id not null), which an upsert cannot name: look, then change or add
    const { data: had } = await acc.sb.from('roar_calendar_events').select('id').eq('owner', acc.userId).eq('source', 'roarmail').eq('source_id', inv.uid).maybeSingle()
    if (had) await acc.sb.from('roar_calendar_events').update(row).eq('id', had.id)
    else await acc.sb.from('roar_calendar_events').insert({ ...row, owner: acc.userId, source: 'roarmail', source_id: inv.uid })
  }

  private async tick(force = false) {
    if (this.busy) return
    this.projects().catch(() => {})
    if (!this.mail.settings().syncSetup) { if (this.state.signedIn || this.state.error) this.set({ signedIn: false, error: '' }); return }
    const acc = await this.roarme.account().catch(() => null)
    if (!acc) { if (this.state.signedIn) this.set({ signedIn: false }); return }
    this.busy = true
    try {
      const { sb, userId } = acc
      // 1. a newer copy from another computer comes in first
      const { data: remote, error } = await sb.from('roarmail_sync').select('data, updated_at, device').eq('user_id', userId).maybeSingle()
      if (error) throw error
      const install = this.mail.installPrint()
      const pulled = this.local('syncPulled') || ''
      // the first sync of this computer: what it had joins what came, and the whole goes up
      const first = !pulled
      let added = 0, skipPush = false
      if (remote && remote.updated_at !== pulled && remote.device !== install && remote.data?.format === 'roarmail-setup') {
        added = this.mail.syncImport(remote.data as SetupBundle)
        this.mail.settingsChanged()
        this.setLocal('syncPulled', remote.updated_at)
        // what just came in is the new starting point: it does not go back up (two computers would answer each other)
        if (!first) { this.lastPrint = printOf(this.mail.syncBundle()); skipPush = true }
      }
      // 2. what changed here goes up (and once every time RoarMail starts)
      const bundle = this.mail.syncBundle()
      const print = printOf(bundle)
      if (!skipPush && (force || first || !remote || print !== this.lastPrint)) {
        const at = new Date().toISOString()
        const { error: up } = await sb.from('roarmail_sync').upsert({ user_id: userId, data: bundle, device: install, updated_at: at })
        if (up) throw up
        this.setLocal('syncPulled', at)
        this.lastPrint = print
      }
      // 3. this computer in the account's device list (every 10 minutes)
      if (force || Date.now() - this.devicesAt > 10 * 60e3) {
        this.devicesAt = Date.now()
        await sb.from('roarmail_devices').upsert({ user_id: userId, install, name: os.hostname().replace(/\.local$/, ''), platform: process.platform, version: app.getVersion(), last_seen: new Date().toISOString() })
      }
      this.set({ signedIn: true, at: Date.now(), error: '', added: added || undefined })
    } catch (e: any) {
      this.set({ signedIn: true, error: String(e?.message || e).slice(0, 200) })
    } finally { this.busy = false }
  }

  // ---------- AI ----------

  private keysFile() { return path.join(app.getPath('userData'), 'ai-keys.bin') }
  private keys(): Record<string, string> {
    try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(this.keysFile()))) } catch { return {} }
  }
  /** a Claude or ChatGPT key of the person's own, kept with the system's key store; '' removes it */
  aiSetKey(provider: 'claude' | 'openai', key: string): AiStatus {
    const k = this.keys()
    const v = String(key || '').trim()
    if (v) k[provider] = v; else delete k[provider]
    if (Object.keys(k).length) fs.writeFileSync(this.keysFile(), safeStorage.encryptString(JSON.stringify(k)))
    else fs.rmSync(this.keysFile(), { force: true })
    return this.aiStatusSync()
  }
  private aiStatusSync(): AiStatus {
    const k = this.keys()
    return { provider: this.mail.settings().aiProvider as AiProvider, claude: !!k.claude, openai: !!k.openai }
  }
  async aiStatus(): Promise<AiStatus> {
    const s = this.aiStatusSync()
    return { ...s, signedIn: !!(await this.roarme.account().catch(() => null)) }
  }

  /** the ✦ button: the text for the message, from the provider chosen in Settings */
  async ai(req: AiRequest): Promise<string> {
    if (!String(req?.instruction || '').trim()) throw new Error('ai-empty')
    const provider = this.mail.settings().aiProvider as AiProvider
    const k = this.keys()
    const user = aiPrompt(req)
    if (provider === 'claude') {
      if (!k.claude) throw new Error('ai-nokey')
      const r = await net.fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': k.claude, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.mail.settings().aiClaudeModel || 'claude-sonnet-5-5', max_tokens: 3000, system: AI_SYSTEM, messages: [{ role: 'user', content: user }] }),
      })
      const j: any = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(r.status === 401 ? 'ai-badkey' : `Claude: ${j?.error?.message || r.status}`)
      return (j.content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim()
    }
    if (provider === 'openai') {
      if (!k.openai) throw new Error('ai-nokey')
      const r = await net.fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${k.openai}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.mail.settings().aiOpenaiModel || 'gpt-5', messages: [{ role: 'system', content: AI_SYSTEM }, { role: 'user', content: user }] }),
      })
      const j: any = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(r.status === 401 ? 'ai-badkey' : `ChatGPT: ${j?.error?.message || r.status}`)
      return String(j.choices?.[0]?.message?.content || '').trim()
    }
    // RoarMail AI, through the Roar Account
    const acc = await this.roarme.account().catch(() => null)
    if (!acc) throw new Error('ai-signin')
    const r = await net.fetch(FN, { method: 'POST', headers: { Authorization: `Bearer ${acc.token}`, apikey: KEY, 'content-type': 'application/json' }, body: JSON.stringify(req) })
    const j: any = await r.json().catch(() => ({}))
    if (r.status === 429) throw new Error('ai-limit')
    if (r.status === 401) throw new Error('ai-signin')
    if (!r.ok) throw new Error(j?.error || `RoarMail AI ${r.status}`)
    return String(j.text || '').trim()
  }
}
