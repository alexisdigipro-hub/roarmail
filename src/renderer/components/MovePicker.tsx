// Move to a folder: type a few letters, arrows to choose, Enter to move (M opens it).
import { useEffect, useState } from 'react'
import type { Folder } from '../../shared/api'
import { t } from '../i18n'
import { Icon, folderIcon } from './Icon'

export function MovePicker({ accountId, exclude, onPick, onClose }: { accountId: string; exclude?: string; onPick: (folderId: string) => void; onClose: () => void }) {
  const [folders, setFolders] = useState<Folder[]>([])
  const [q, setQ] = useState('')
  const [pick, setPick] = useState(0)

  useEffect(() => { window.roarmail.folders(accountId).then((f) => setFolders(f.filter((x) => x.id !== exclude))) }, [accountId])

  const name = (f: Folder) => (f.role ? (t as Record<string, string>)[f.role] || f.name : f.name)
  const list = folders.filter((f) => !q || name(f).toLowerCase().includes(q.toLowerCase()) || f.path.toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="sheet-wrap" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet picker" onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); onClose() }
        if (e.key === 'ArrowDown') { e.preventDefault(); setPick((p) => Math.min(list.length - 1, p + 1)) }
        if (e.key === 'ArrowUp') { e.preventDefault(); setPick((p) => Math.max(0, p - 1)) }
        if (e.key === 'Enter' && list[pick]) { e.preventDefault(); onPick(list[pick].id) }
      }}>
        <label className="search big">
          <Icon name="folder" size={16} />
          <input autoFocus value={q} placeholder={t.moveFilter} onChange={(e) => { setQ(e.target.value); setPick(0) }} />
        </label>
        <div className="picker-list">
          {list.map((f, i) => (
            <button key={f.id} className={`folder ${i === pick ? 'on' : ''}`} onMouseEnter={() => setPick(i)} onClick={() => onPick(f.id)}>
              <Icon name={folderIcon(f.role)} size={16} />
              <span className="grow ellipsis">{name(f)}</span>
              {!f.role && f.depth > 0 && <span className="muted small ellipsis">{f.path}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

