// RoarMail AI (Edge Function roarmail-ai, in RoarMe's Supabase project beside roarwriter-ai and roarmind-ai).
// Alex, 3 Nov 2026: a button in a new message, "tell it what to say and it writes the mail". Only a signed-in Roar Account
// may ask, a few dozen times a day (roarmail_ai_take); the person can use their own Claude or ChatGPT key in RoarMail
// instead, which never comes here. The app sends only what the person asked for and the message being answered, only
// when the button is pressed. The Anthropic API key is the project's secret ANTHROPIC_API_KEY, never in the app.
import Anthropic from 'npm:@anthropic-ai/sdk'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
const DAILY = 30

const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') })

export const SYSTEM = `You write emails for the person using RoarMail, a mail app. They are often in film and video production, in Greece; mail is in Greek or English.
What you get: what they want (their own words), and sometimes the text they already wrote or selected, and the message they are answering.

Rules:
- Write in the language they ask for; otherwise the language of their own words; when answering, the language of the message answered.
- Greek in natural, correct modern Greek with the right tone (formal "σας" for clients and people they do not know, friendly "σου" when the message answered does so).
- Give only the text that goes into the email body: no subject line, no "Here is your email", no notes, no markdown, no signature (the app adds it), no sign-off name.
- Start with a greeting only if one fits; end with a short closing like "Ευχαριστώ," / "Best," only if it fits.
- Never invent facts, dates, amounts or names they did not give; if something needed is missing, write a short placeholder in brackets, like [ημερομηνία].
- When asked to change text they wrote (shorter, more formal, fix, translate), return only the changed text, keeping its meaning.
- Keep it as short as the request allows. Plain paragraphs separated by one empty line.`

async function ask(user: string) {
  const msg = await client.beta.messages.create({
    model: 'claude-sonnet-5-5',
    max_tokens: 3000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    messages: [{ role: 'user', content: user }],
  } as any)
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('refusal'), { refusal: true })
  return msg.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n').trim()
}

/** the request as one message to Claude (the app's own-key path builds the same) */
export function prompt(b: any): string {
  const cut = (v: unknown, n: number) => String(v || '').slice(0, n).trim()
  const parts = [`What I want: ${cut(b.instruction, 2000)}`]
  if (cut(b.text, 1)) parts.push(`${b.selection ? 'The text to change' : 'What I wrote so far'}:\n${cut(b.text, 12000)}`)
  if (cut(b.thread, 1)) parts.push(`The message I am answering${b.threadFrom ? ` (from ${cut(b.threadFrom, 200)})` : ''}:\n${cut(b.thread, 12000)}`)
  if (cut(b.to, 1)) parts.push(`It goes to: ${cut(b.to, 500)}`)
  if (cut(b.subject, 1)) parts.push(`Subject: ${cut(b.subject, 300)}`)
  if (cut(b.me, 1)) parts.push(`I am: ${cut(b.me, 200)}`)
  return parts.join('\n\n')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'POST') return reply({ error: 'POST only' }, 405)
  try {
    const url = Deno.env.get('SUPABASE_URL')!
    const who = await fetch(`${url}/auth/v1/user`, { headers: { Authorization: req.headers.get('Authorization') || '', apikey: Deno.env.get('SUPABASE_ANON_KEY') || '' } })
    if (!who.ok) return reply({ error: 'signin' }, 401)
    const user = await who.json()
    const b = await req.json().catch(() => ({}))
    if (!String(b.instruction || '').trim()) return reply({ error: 'Write what the mail should say first.' }, 400)
    // the free allowance: one more today, if there is one left
    const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const take = await fetch(`${url}/rest/v1/rpc/roarmail_ai_take`, {
      method: 'POST', headers: { apikey: svc, Authorization: `Bearer ${svc}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_user: user.id, p_limit: DAILY }),
    })
    const used = take.ok ? Number(await take.json()) : 0
    if (used < 0) return reply({ error: 'limit', limit: DAILY }, 429)
    return reply({ text: await ask(prompt(b)), used, limit: DAILY })
  } catch (e) {
    if ((e as any)?.refusal) return reply({ error: 'Claude would not write this one.' }, 422)
    return reply({ error: 'Claude could not answer just now. Try again in a moment.' }, 502)
  }
})
