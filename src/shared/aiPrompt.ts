// RoarMail AI's instructions and the request as one message (3 Nov 2026). The same text is in the Edge Function
// supabase/functions/roarmail-ai (RoarMail AI through the Roar Account); RoarMail uses this one with the person's own
// Claude or ChatGPT key. Keep both alike.

export const AI_SYSTEM = `You write emails for the person using RoarMail, a mail app. They are often in film and video production, in Greece; mail is in Greek or English.
What you get: what they want (their own words), and sometimes the text they already wrote or selected, and the message they are answering.

Rules:
- Write in the language they ask for; otherwise the language of their own words; when answering, the language of the message answered.
- Greek in natural, correct modern Greek with the right tone (formal "σας" for clients and people they do not know, friendly "σου" when the message answered does so).
- Give only the text that goes into the email body: no subject line, no "Here is your email", no notes, no markdown, no signature (the app adds it), no sign-off name.
- Start with a greeting only if one fits; end with a short closing like "Ευχαριστώ," / "Best," only if it fits.
- Never invent facts, dates, amounts or names they did not give; if something needed is missing, write a short placeholder in brackets, like [ημερομηνία].
- When asked to change text they wrote (shorter, more formal, fix, translate), return only the changed text, keeping its meaning.
- Keep it as short as the request allows. Plain paragraphs separated by one empty line.`

/** what the composer sends when the AI button is used */
export interface AiRequest {
  /** what the person wants, in their own words ("say the shoot moves to Tuesday, politely, in English") */
  instruction: string
  /** the text selected (selection true) or written so far */
  text?: string; selection?: boolean
  /** the message being answered, as text, and who it is from */
  thread?: string; threadFrom?: string
  to?: string; subject?: string; me?: string
}

export function aiPrompt(b: AiRequest): string {
  const cut = (v: unknown, n: number) => String(v || '').slice(0, n).trim()
  const parts = [`What I want: ${cut(b.instruction, 2000)}`]
  if (cut(b.text, 1)) parts.push(`${b.selection ? 'The text to change' : 'What I wrote so far'}:\n${cut(b.text, 12000)}`)
  if (cut(b.thread, 1)) parts.push(`The message I am answering${b.threadFrom ? ` (from ${cut(b.threadFrom, 200)})` : ''}:\n${cut(b.thread, 12000)}`)
  if (cut(b.to, 1)) parts.push(`It goes to: ${cut(b.to, 500)}`)
  if (cut(b.subject, 1)) parts.push(`Subject: ${cut(b.subject, 300)}`)
  if (cut(b.me, 1)) parts.push(`I am: ${cut(b.me, 200)}`)
  return parts.join('\n\n')
}
