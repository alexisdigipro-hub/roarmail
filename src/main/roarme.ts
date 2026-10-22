// RoarMail and RoarMe. The person signs in to their RoarMe account (optional, with two-step verification when
// they have it); RoarMail then talks to RoarMe's Supabase as that person, through RoarMe's own rules, like any
// RoarMe device: share an email into a chat, make a task from an email, see their tasks and calendar (RoarMe's
// and the THEMADLIONS hub's). Mail passwords never go to RoarMe. The session lives here, in the main process,
// encrypted with the system key store; the screens only get names and lists.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { app, shell } from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { safeStorage } from 'electron'
import type { RoarMeStatus, RoarRoom, RoarPerson, RoarTask, RoarTransferFile, RoarTransferLink, RoarWork, RoarTaskInput } from '../shared/api'

// RoarMe's project and its publishable key (public by design, as in RoarMe's own src/lib.js)
const URL = 'https://bzmjhbnwhdwmncxkqkdl.supabase.co'
const KEY = 'sb_publishable_7mQ3e0NH5lCmdoIKx2-FUA_EgCoXx9X'
export const ROARME_WEB = 'https://alexisdigipro-hub.github.io/roarme/'
const MAX_FILE = 50 * 1024 * 1024 // RoarMe's chat file limit; bigger goes by RoarTransfer (later)
// RoarTransfer on Cloudflare R2 since 22 Oct 2026, as roartransfer.com (RoarMe's Edge Function roartransfer-r2)
const R2_FN = `${URL}/functions/v1/roartransfer-r2`
const R2_PART = 16 * 1024 * 1024
const GB = 1024 ** 3
const TRANSFER_PAGE = 'https://roartransfer.com/'
const MIME: Record<string, string> = {
  pdf: 'application/pdf', zip: 'application/zip', mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/mp4', mxf: 'application/mxf',
  wav: 'audio/wav', mp3: 'audio/mpeg', aif: 'audio/aiff', aiff: 'audio/aiff', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  tif: 'image/tiff', tiff: 'image/tiff', psd: 'image/vnd.adobe.photoshop', mkv: 'video/x-matroska', webm: 'video/webm',
}

/** the session, encrypted on disk (Keychain / DPAPI) */
function vaultStorage() {
  const file = path.join(app.getPath('userData'), 'roarme-session.bin')
  const read = (): Record<string, string> => {
    try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(file))) } catch { return {} }
  }
  const write = (o: Record<string, string>) => {
    if (!Object.keys(o).length) { fs.rmSync(file, { force: true }); return }
    fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(o)))
  }
  return {
    getItem: (k: string) => read()[k] ?? null,
    setItem: (k: string, v: string) => { const o = read(); o[k] = v; write(o) },
    removeItem: (k: string) => { const o = read(); delete o[k]; write(o) },
  }
}

export class RoarMe {
  private sb: SupabaseClient
  private me: RoarPerson | null = null

  constructor(private onChange: () => void) {
    this.sb = createClient(URL, KEY, {
      auth: { storage: vaultStorage(), storageKey: 'roarmail-roarme', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    })
    this.sb.auth.onAuthStateChange(() => { this.me = null; this.onChange() })
  }

  private async userId(): Promise<string> {
    const { data } = await this.sb.auth.getSession()
    const id = data.session?.user.id
    if (!id) throw new Error('roarme-signed-out')
    return id
  }

  async status(): Promise<RoarMeStatus> {
    const { data } = await this.sb.auth.getSession()
    const user = data.session?.user
    if (!user) return { signedIn: false, needsMfa: false }
    const aal = await this.sb.auth.mfa.getAuthenticatorAssuranceLevel()
    const needsMfa = aal.data?.nextLevel === 'aal2' && aal.data?.currentLevel !== 'aal2'
    if (needsMfa) return { signedIn: true, needsMfa: true, email: user.email }
    if (!this.me) {
      const { data: p } = await this.sb.from('roar_people').select('id, username, display_name, avatar_url').eq('id', user.id).maybeSingle()
      this.me = { id: user.id, name: p?.display_name || p?.username || user.email || '', username: p?.username || '', avatar: p?.avatar_url || undefined }
    }
    return { signedIn: true, needsMfa: false, email: user.email, me: this.me }
  }

  async signIn(email: string, password: string): Promise<RoarMeStatus> {
    const { error } = await this.sb.auth.signInWithPassword({ email: email.trim(), password })
    if (error) throw new Error(/invalid/i.test(error.message) ? 'roarme-wrong' : error.message)
    return this.status()
  }

  /** the 6-digit code of the authenticator app, when the account has two-step verification */
  async verify(code: string): Promise<RoarMeStatus> {
    const { data } = await this.sb.auth.mfa.listFactors()
    const factor = data?.totp?.find((f) => f.status === 'verified') || data?.totp?.[0]
    if (!factor) throw new Error('roarme-no-factor')
    const { error } = await this.sb.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.replace(/\s/g, '') })
    if (error) throw new Error('roarme-code')
    return this.status()
  }

  async signOut() {
    await this.sb.auth.signOut({ scope: 'local' }).catch(() => {})
    this.me = null
    this.onChange()
  }

  private async people(ids: string[]): Promise<Map<string, RoarPerson>> {
    if (!ids.length) return new Map()
    const { data } = await this.sb.from('roar_people').select('id, username, display_name, avatar_url').in('id', ids)
    return new Map((data || []).map((p: any) => [p.id, { id: p.id, name: p.display_name || p.username || '', username: p.username || '', avatar: p.avatar_url || undefined }]))
  }

  /** the person's chats, newest first; a direct chat is named after the other person */
  async rooms(): Promise<RoarRoom[]> {
    const me = await this.userId()
    const { data, error } = await this.sb.rpc('roar_my_rooms')
    if (error) throw new Error(error.message)
    const list = (data || []) as any[]
    const ids = [...new Set(list.flatMap((r) => r.members || []))] as string[]
    const who = await this.people(ids)
    return list.filter((r) => !r.archived).map((r) => {
      const members = ((r.members || []) as string[]).map((id) => who.get(id)).filter(Boolean) as RoarPerson[]
      const others = members.filter((p) => p.id !== me)
      const title = r.title || (r.kind === 'saved' ? 'Saved' : others.map((p) => p.name).join(', ')) || 'RoarMe'
      return { id: r.room_id, kind: r.kind, title, avatar: r.avatar_url || (others.length === 1 ? others[0].avatar : undefined), members, unread: r.unread || 0 }
    })
  }

  /** people a task can go to: oneself, and everyone one shares a chat with */
  async contacts(): Promise<RoarPerson[]> {
    const me = await this.userId()
    const rooms = await this.rooms()
    const all = new Map<string, RoarPerson>()
    for (const r of rooms) for (const p of r.members) if (p.id !== me) all.set(p.id, p)
    return [...all.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** an email into a chat: a text message RoarMe shows today, with the details kept in file.mail; attachments follow */
  async share(roomId: string, mail: { subject: string; from: string; date: number; snippet: string; messageId?: string }, note: string,
    files: { name: string; type: string; content: Buffer }[]) {
    const me = await this.userId()
    const when = new Date(mail.date).toLocaleString('el-GR', { dateStyle: 'medium', timeStyle: 'short' })
    const body = [note.trim(), `✉️ ${mail.subject || '(χωρίς θέμα)'}`, `${mail.from} · ${when}`, mail.snippet.slice(0, 600)].filter(Boolean).join('\n')
    const { error } = await this.sb.from('roar_messages').insert({
      room_id: roomId, user_id: me, kind: 'text', body: body.slice(0, 4000),
      file: { mail: { v: 1, subject: mail.subject, from: mail.from, date: new Date(mail.date).toISOString(), snippet: mail.snippet.slice(0, 600), messageId: mail.messageId || null, app: 'RoarMail' } },
    })
    if (error) throw new Error(error.message)
    let skipped = 0
    for (const f of files) {
      if (f.content.length > MAX_FILE) { skipped++; continue }
      const p = `${roomId}/${crypto.randomUUID()}-${f.name.replace(/[^\w.\-]+/g, '_').slice(-120)}`
      const up = await this.sb.storage.from('roar-files').upload(p, f.content, { contentType: f.type || 'application/octet-stream', upsert: false })
      if (up.error) { skipped++; continue }
      const { error: e2 } = await this.sb.from('roar_messages').insert({
        room_id: roomId, user_id: me, kind: 'file', body: f.name, file: { path: p, name: f.name, size: f.content.length, type: f.type },
      })
      if (e2) skipped++
    }
    return { skipped }
  }

  async makeTask(t: RoarTaskInput) {
    const me = await this.userId()
    const { error } = await this.sb.from('roar_tasks').insert({
      assignee: t.assignee || me, title: t.title.trim().slice(0, 300) || '—', notes: t.notes.slice(0, 4000),
      due: t.due || null, priority: t.priority || 'normal',
    })
    if (error) throw new Error(/share a chat/.test(error.message) ? 'roarme-assignee' : error.message)
  }

  async setTaskStatus(id: string, status: RoarTask['status']) {
    const { error } = await this.sb.from('roar_tasks').update({ status }).eq('id', id)
    if (error) throw new Error(error.message)
  }

  /** tasks (theirs and given), upcoming calls in their chats, and the THEMADLIONS hub's tasks and events if linked */
  async work(): Promise<RoarWork> {
    const me = await this.userId()
    const [tasksQ, callsQ, hubQ] = await Promise.all([
      this.sb.from('roar_tasks').select('id, created_by, assignee, title, notes, due, priority, status, updated_at')
        .or(`assignee.eq.${me},created_by.eq.${me}`).in('status', ['pending', 'open', 'doing']).order('due', { ascending: true, nullsFirst: false }).limit(200),
      this.sb.from('roar_messages').select('id, room_id, body, file').not('file->event', 'is', null).is('deleted_at', null)
        .gte('file->event->>start', new Date(Date.now() - 3600e3).toISOString()).lt('file->event->>start', new Date(Date.now() + 30 * 864e5).toISOString()).limit(200),
      this.sb.functions.invoke('roar-hub-work', { body: {} }).catch(() => ({ data: null })),
    ])
    const ids = [...new Set((tasksQ.data || []).flatMap((t: any) => [t.assignee, t.created_by]))] as string[]
    const who = await this.people(ids)
    const tasks: RoarTask[] = (tasksQ.data || []).map((t: any) => ({
      id: t.id, title: t.title, notes: t.notes, due: t.due, priority: t.priority, status: t.status,
      mine: t.assignee === me, from: t.created_by === me ? undefined : who.get(t.created_by)?.name, to: t.assignee === me ? undefined : who.get(t.assignee)?.name,
    }))
    const events = (callsQ.data || []).map((m: any) => ({ id: m.id, roomId: m.room_id, title: m.file?.event?.title || m.body || '', start: m.file?.event?.start, video: !!m.file?.event?.video }))
      .filter((e: any) => e.start).sort((a: any, b: any) => a.start.localeCompare(b.start))
    const hub = (hubQ as any)?.data || {}
    return {
      tasks, events,
      hub: { linked: !!hub.linked, tasks: (hub.tasks || []).slice(0, 100), events: (hub.events || []).slice(0, 100) },
    }
  }

  /** a call to RoarTransfer's bridge to Cloudflare R2 (RoarMe's Edge Function roartransfer-r2), signed in */
  private async r2(body: Record<string, unknown>) {
    const { data } = await this.sb.auth.getSession()
    if (!data.session) throw new Error('roarme-signed-out')
    const r = await fetch(R2_FN, { method: 'POST', headers: { apikey: KEY, Authorization: `Bearer ${data.session.access_token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    let d: any = {}
    try { d = await r.json() } catch { /* not JSON */ }
    if (!r.ok) throw Object.assign(new Error(d.error === 'signed-out' ? 'roarme-signed-out' : d.error || `RoarTransfer (${r.status})`), { fatal: r.status < 500 })
    return d
  }

  /** a big attachment for a RoarTransfer link, as on roartransfer.com (Alex, 22 Oct 2026): the file goes to
   * Cloudflare R2 in 16 MB pieces, three at a time, each signed by roartransfer-r2. days 1 = up to 5 GB, 3 = up to 3 GB.
   * Gives the file's token; transferBundle then makes ONE link for all the email's files. progress gets 0..1. */
  async transfer(file: string, progress: (p: number) => void, stop: { stopped?: boolean } = {}, days = 3): Promise<RoarTransferFile> {
    const size = fs.statSync(file).size
    if (size > (days === 1 ? 5 : 3) * GB) throw new Error('roarme-too-big')
    const name = path.basename(file)
    const type = MIME[path.extname(name).slice(1).toLowerCase()] || 'application/octet-stream'
    const made = await this.r2({ action: 'create', name, size, type, days })
    const n = Math.max(1, Math.ceil(size / R2_PART))
    const urls: Record<number, string> = {}
    const etags: Record<number, string> = {}
    const loaded: Record<number, number> = {}
    const tell = () => progress(Object.values(loaded).reduce((a, x) => a + x, 0) / size)
    let next = 1
    let signing: Promise<void> | null = null
    const urlFor = async (i: number) => {
      while (!urls[i]) {
        if (!signing) {
          const want: number[] = []
          for (let k = i; k <= Math.min(n, i + 19); k++) if (!urls[k] && !etags[k]) want.push(k)
          signing = this.r2({ action: 'sign', key: made.key, uploadId: made.uploadId, parts: want })
            .then((got) => { Object.assign(urls, got.urls) })
            .finally(() => { signing = null })
        }
        await signing
      }
      return urls[i]
    }
    const fd = await fs.promises.open(file, 'r')
    const worker = async () => {
      for (;;) {
        if (stop.stopped) throw new Error('cancelled')
        const i = next++
        if (i > n) return
        const from = (i - 1) * R2_PART
        const len = Math.min(R2_PART, size - from)
        const buf = new Uint8Array(len)
        await fd.read(buf, 0, len, from)
        let tries = 0
        for (;;) {
          try {
            const r = await fetch(await urlFor(i), { method: 'PUT', body: buf })
            if (r.ok) { etags[i] = r.headers.get('etag') || ''; loaded[i] = len; tell(); break }
            if (r.status === 403) delete urls[i] // its signature ran out: sign it again
            throw new Error(`RoarTransfer (${r.status})`)
          } catch (e: any) {
            if (stop.stopped || e?.fatal) throw e
            if (++tries > 6) throw e
            await new Promise((ok) => setTimeout(ok, Math.min(30000, 1000 * 2 ** tries)))
          }
        }
      }
    }
    try { await Promise.all([worker(), worker(), worker()]) } catch (e) {
      this.r2({ action: 'abort', key: made.key, uploadId: made.uploadId }).catch(() => {})
      throw e
    } finally { await fd.close() }
    const parts = Object.keys(etags).map((k) => ({ n: +k, etag: etags[+k] }))
    const fin = await this.r2({ action: 'complete', key: made.key, uploadId: made.uploadId, parts, name, size, type, days })
    progress(1)
    return { token: fin.token, name, size: fin.size || size, type, expires: fin.expires }
  }

  /** one link for every file an email sends by RoarTransfer, with the email's subject as its title, an optional
   * password and an email to the sender when someone downloads. With one file, its own link if the bundle fails. */
  async transferBundle(files: RoarTransferFile[], opts: { title?: string; password?: string; notify?: boolean } = {}): Promise<RoarTransferLink> {
    const size = files.reduce((a, f) => a + f.size, 0)
    const name = files.length === 1 ? files[0].name : `${files.length} files`
    try {
      const b = await this.r2({ action: 'bundle', tokens: files.map((f) => f.token), title: opts.title || '', message: '', recipients: [], password: opts.password || '', notify: !!opts.notify })
      return { url: TRANSFER_PAGE + b.token, name, size, expires: b.expires, files, locked: !!opts.password }
    } catch (e) {
      if (files.length === 1) return { url: TRANSFER_PAGE + files[0].token, name, size, expires: files[0].expires, files, locked: false }
      throw e
    }
  }

  /** RoarMe's desktop app when it is installed (roarme://, from RoarMe 1.5), else the RoarMe site */
  private openRoarMe(hash: string) {
    const handler = (() => { try { return app.getApplicationNameForProtocol('roarme://') } catch { return '' } })()
    if (handler) {
      const link = hash.startsWith('#c=') ? `roarme://c/${hash.slice(3)}` : hash.startsWith('#m=') ? `roarme://m/${hash.slice(3)}` : 'roarme://'
      shell.openExternal(link).catch(() => shell.openExternal(`${ROARME_WEB}${hash}`))
    } else shell.openExternal(`${ROARME_WEB}${hash}`)
  }

  open(where: { roomId?: string; messageId?: string; hub?: 'tasks' | 'calendar' }) {
    const id = /^[0-9a-f-]{36}$/
    if (where.hub) shell.openExternal(`https://hub.themadlions.com/#/${where.hub}`)
    else if (where.roomId && id.test(where.roomId)) this.openRoarMe(where.messageId && id.test(where.messageId) ? `#m=${where.roomId}/${where.messageId}` : `#c=${where.roomId}`)
    else this.openRoarMe('')
  }
}
