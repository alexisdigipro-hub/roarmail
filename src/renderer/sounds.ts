// RoarMail's sounds (Settings > General): made here with Web Audio, so there are no sound files to ship.
// New mail plays the chosen one; with "sounds for other actions" on, send, archive and delete have their own.
import type { NewMailSound } from '../shared/api'

let ctx: AudioContext | null = null
let actions = false

/** one soft note: a sine (or triangle) that rises fast and fades */
function note(freq: number, at: number, len: number, gain = 0.18, type: OscillatorType = 'sine', glide = 0) {
  ctx ||= new AudioContext()
  const t = ctx.currentTime + at
  const o = ctx.createOscillator(), g = ctx.createGain()
  o.type = type
  o.frequency.setValueAtTime(freq, t)
  if (glide) o.frequency.exponentialRampToValueAtTime(freq * glide, t + len)
  g.gain.setValueAtTime(0.0001, t)
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012)
  g.gain.exponentialRampToValueAtTime(0.0001, t + len)
  o.connect(g).connect(ctx.destination)
  o.start(t); o.stop(t + len + 0.05)
}

const NEW_MAIL: Record<NewMailSound, () => void> = {
  // a low growl that opens up: RoarMail's own
  roar: () => { note(110, 0, 0.45, 0.16, 'sawtooth', 1.6); note(220, 0.04, 0.4, 0.08, 'triangle', 1.5) },
  chime: () => { note(1046.5, 0, 0.5); note(1568, 0.11, 0.7, 0.14) },
  drop: () => { note(1400, 0, 0.28, 0.2, 'sine', 0.45) },
  pop: () => { note(620, 0, 0.12, 0.22, 'triangle', 1.8) },
  breeze: () => { note(659.3, 0, 0.6, 0.1); note(880, 0.09, 0.6, 0.1); note(1318.5, 0.18, 0.8, 0.08) },
}

export const NEW_MAIL_SOUNDS = Object.keys(NEW_MAIL) as NewMailSound[]

export function playNewMail(s: NewMailSound) {
  try { NEW_MAIL[s]?.() } catch { /* no audio here */ }
}

export function setActionSounds(on: boolean) { actions = on }

export function actionSound(kind: 'send' | 'archive' | 'trash') {
  if (!actions) return
  try {
    if (kind === 'send') note(520, 0, 0.35, 0.14, 'sine', 2.4)
    else if (kind === 'archive') { note(880, 0, 0.1, 0.12); note(660, 0.07, 0.16, 0.1) }
    else note(300, 0, 0.18, 0.16, 'triangle', 0.5)
  } catch { /* no audio here */ }
}
