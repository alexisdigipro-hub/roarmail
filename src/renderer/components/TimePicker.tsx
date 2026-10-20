// One picker for "snooze until" and "send at": the ready-made times, or a day and hour of your own.
import { useState } from 'react'
import { t } from '../i18n'
import { localInput, presets, short } from '../when'
import { Icon } from './Icon'

export function TimePicker({ title, aside, onPick, onClose }: {
  title: string
  /** show "Set aside" (no time, comes back only by hand) */
  aside?: boolean
  onPick: (at: number | null) => void
  onClose: () => void
}) {
  const list = presets()
  const [custom, setCustom] = useState(localInput(list[list.length > 1 ? 1 : 0].at))
  const [pick, setPick] = useState(0)
  return (
    <div className="sheet-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet picker time-picker" tabIndex={-1} autoFocus onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); onClose() }
        if ((e.target as HTMLElement).tagName === 'INPUT') return
        if (e.key === 'ArrowDown') { e.preventDefault(); setPick((p) => Math.min(list.length - 1, p + 1)) }
        if (e.key === 'ArrowUp') { e.preventDefault(); setPick((p) => Math.max(0, p - 1)) }
        if (e.key === 'Enter') { e.preventDefault(); onPick(list[pick].at) }
      }}>
        <div className="row"><Icon name="clock" size={18} /><h3 className="grow">{title}</h3></div>
        <div className="picker-list">
          {list.map((p, i) => (
            <button key={p.key} className={`folder ${i === pick ? 'on' : ''}`} onMouseEnter={() => setPick(i)} onClick={() => onPick(p.at)}>
              <span className="grow">{p.label}</span><span className="muted small">{short(p.at)}</span>
            </button>
          ))}
          {aside && (
            <button className="folder" onClick={() => onPick(null)}><span className="grow">{t.w_aside}</span><span className="muted small">{t.w_asideHint}</span></button>
          )}
        </div>
        <div className="row custom-time">
          <input type="datetime-local" value={custom} min={localInput(Date.now())} onChange={(e) => setCustom(e.target.value)} />
          <button className="pill small primary" onClick={() => { const v = new Date(custom).getTime(); if (v > Date.now()) onPick(v) }}>{t.w_pick}</button>
        </div>
      </div>
    </div>
  )
}
