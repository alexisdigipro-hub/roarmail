// RoarMail's own line icons (24px grid, 1.6 stroke).
const P: Record<string, string> = {
  compose: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3zM14 7l3 3',
  reply: 'M10 8 5 12.5l5 4.5M5 12.5h9a5 5 0 0 1 5 5V19',
  replyAll: 'M11 8l-5 4.5 5 4.5M7 8l-5 4.5L7 17M6 12.5h8a5 5 0 0 1 5 5V19',
  forward: 'M14 8l5 4.5-5 4.5M19 12.5h-9a5 5 0 0 0-5 5V19',
  archive: 'M4 5h16v4H4zM5.5 9v10h13V9M10 13h4',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10.5 11v5M13.5 11v5',
  star: 'M12 4l2.4 5 5.4.6-4 3.7 1.1 5.3L12 16l-4.9 2.6 1.1-5.3-4-3.7 5.4-.6z',
  dot: 'M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0',
  search: 'M11 11m-6 0a6 6 0 1 0 12 0a6 6 0 1 0-12 0M20 20l-4.5-4.5',
  refresh: 'M19 12a7 7 0 1 1-2.1-5M19 4v4h-4',
  inbox: 'M4 13l2.5-7h11L20 13v6H4zM4 13h5l1 2h4l1-2h5',
  sent: 'M4 12l16-8-6 16-2.5-6.5z',
  drafts: 'M6 3h9l4 4v14H6zM14 3v5h5',
  spam: 'M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7zM12 8v5M12 16v.5',
  folder: 'M3.5 7V18h17V8.5h-9L9.5 6h-6z',
  all: 'M5 6h14M5 12h14M5 18h14',
  clip: 'M16.5 7.5 9 15a2 2 0 0 0 3 3l7.5-7.5a4 4 0 0 0-6-6L6 12a6 6 0 0 0 8.5 8.5L20 15',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  chevron: 'M9 6l6 6-6 6',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 2-2 5 5M15.5 9.5m-1.5 0a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  download: 'M12 4v11M7 10.5 12 15l5-4.5M5 19h14',
  more: 'M6 12h.01M12 12h.01M18 12h.01',
  unread: 'M4 7l8 6 8-6M4 6h16v12H4z',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-5',
  shieldAlert: 'M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6zM12 8v5M12 16v.5',
  info: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 11v5M12 8v.5',
  block: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M6.4 6.4l11.2 11.2',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  clock: 'M12 12m-8.5 0a8.5 8.5 0 1 0 17 0a8.5 8.5 0 1 0-17 0M12 7.5V12l3 2',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  palette: 'M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3zM7.5 11.5h.01M10 7.5h.01M14.5 7.5h.01M17 11h.01',
  keyboard: 'M3 7h18v11H3zM7 11h.01M11 11h.01M15 11h.01M8 15h8',
  type: 'M4 19 9.5 5h1L16 19M6.2 14h7.6M16.5 19l2.5-7 2.5 7M17.4 16.7h3.2',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3.5v4M16 3.5v4M12 14h.01',
  sort: 'M7 5v14M4 16l3 3 3-3M14 7h6M14 12h4.5M14 17h3',
  sliders: 'M4 7h9M17 7h3M15 5v4M4 17h3M11 17h9M9 15v4M4 12h13M20 12h0',
  roar: 'M8 10.5a1.6 2 0 1 0 0-.01M12 8a1.6 2 0 1 0 0-.01M16 10.5a1.6 2 0 1 0 0-.01M6.5 14.5a1.5 1.8 0 1 0 0-.01M12 13c-2.6 0-4.5 2.6-4.5 4.4 0 1.4 1.2 2.1 2.4 2.1.9 0 1.4-.4 2.1-.4s1.2.4 2.1.4c1.2 0 2.4-.7 2.4-2.1C16.5 15.6 14.6 13 12 13zM17.5 14.5a1.5 1.8 0 1 0 0-.01',
  tasks: 'M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2',
  gear: 'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8',
}

export function Icon({ name, size = 18, filled = false }: { name: keyof typeof P | string; size?: number; filled?: boolean }) {
  return (
    <svg className="ic" width={size} height={size} viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor"
      strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={P[name] || P.folder} />
    </svg>
  )
}

export const folderIcon = (role: string | null) =>
  role === 'inbox' ? 'inbox' : role === 'sent' ? 'sent' : role === 'drafts' ? 'drafts' : role === 'trash' ? 'trash'
    : role === 'spam' ? 'spam' : role === 'archive' ? 'archive' : role === 'flagged' ? 'star' : role === 'all' ? 'all' : role === 'snoozed' ? 'clock' : 'folder'
