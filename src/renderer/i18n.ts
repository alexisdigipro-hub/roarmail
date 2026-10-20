// Greek and English; the app follows the system language.
const el = {
  appearance: 'Εμφάνιση', ap_system: 'Αυτόματα, όπως το σύστημα', ap_dark: 'Σκούρο', ap_light: 'Ανοιχτό',
  privacy: 'Απόρρητο', blockTrackers: 'Μπλοκάρισμα tracking pixels (και όταν φαίνονται οι εικόνες)', stripTracking: 'Καθάρισμα συνδέσμων από utm και παρόμοια',
  appLock: 'Κλείδωμα με Touch ID', lockAfter: 'Κλείδωμα μετά από', minutes: 'λεπτά', onlySleep: 'Μόνο στο άνοιγμα και στον ύπνο', lockNow: 'Κλείδωμα τώρα',
  lockUnavailable: 'Χρειάζεται Mac με Touch ID. Στα Windows έρχεται σύντομα με Windows Hello.', blockedSenders: 'Μπλοκαρισμένοι αποστολείς', noneBlocked: 'Κανένας',
  unblock: 'Ξεμπλοκάρισμα', blockSender: 'Μπλοκάρισμα αποστολέα', unblockSender: 'Ξεμπλοκάρισμα αποστολέα',
  blockQ: 'Τα επόμενα μηνύματα από αυτόν τον αποστολέα θα πηγαίνουν κατευθείαν στον κάδο.', blockedNote: 'Μπλοκαρίστηκε: τα επόμενα μηνύματα πάνε στον κάδο.',
  unsubscribeOne: 'Διαγραφή από τη λίστα (ένα κλικ)', unsubscribeQ: 'Να σταματήσουν τα μηνύματα από αυτή τη λίστα;',
  unsubDone: 'Έγινε διαγραφή από τη λίστα.', unsubSent: 'Στάλθηκε αίτημα διαγραφής.', unsubOpened: 'Άνοιξε η σελίδα διαγραφής στον browser.', unsubNone: 'Η λίστα δεν δίνει τρόπο διαγραφής.',
  tracker1: 'Μπλοκαρίστηκε 1 tracker', trackersN: 'trackers μπλοκαρίστηκαν',
  sec_auth: 'Προσοχή: ο server σου δεν μπόρεσε να επιβεβαιώσει ότι το μήνυμα ήρθε πραγματικά από αυτόν τον αποστολέα.',
  sec_name: 'Το όνομα του αποστολέα δείχνει άλλη διεύθυνση από την πραγματική.', sec_reply: 'Οι απαντήσεις θα πάνε στο',
  linkCheck: 'Έλεγχος συνδέσμου', linkGoesTo: 'Ο σύνδεσμος οδηγεί στο', copyLink: 'Αντιγραφή', openAnyway: 'Άνοιγμα παρ’ όλα αυτά',
  lw_mismatch: 'Το κείμενο του συνδέσμου δείχνει άλλο site από αυτό που ανοίγει.', lw_lookalike: 'Η διεύθυνση έχει γράμματα που μοιάζουν με λατινικά αλλά δεν είναι.',
  lw_ip: 'Ο σύνδεσμος πάει σε αριθμητική διεύθυνση αντί για όνομα site.', lw_insecure: 'Η σύνδεση δεν είναι κρυπτογραφημένη (http).',
  locked: 'Το RoarMail είναι κλειδωμένο', unlock: 'Ξεκλείδωμα',
  undo: 'Αναίρεση', archived: 'Αρχειοθετήθηκε', trashed: 'Στον κάδο', moved: 'Μετακινήθηκε', deleted: 'Διαγράφηκε',
  sentIn: 'Αποστέλλεται', sendFailed: 'Δεν στάλθηκε', retry: 'Ξανά', edit: 'Επεξεργασία', outboxWaiting: 'σε αναμονή στα Εξερχόμενα',
  moveTo: 'Μετακίνηση σε…', moveFilter: 'Γράψε όνομα φακέλου', selected: 'επιλεγμένα', selectAll: 'Επιλογή όλων',
  messages: 'μηνύματα', saveDraft: 'Αποθήκευση πρόχειρου', draftSaved: 'Αποθηκεύτηκε στα Πρόχειρα', keepWriting: 'Συνέχεια γραφής',
  settings: 'Ρυθμίσεις', accounts: 'Λογαριασμοί', signatures: 'Υπογραφές', general: 'Γενικά', newSignature: 'Νέα υπογραφή',
  signatureName: 'Όνομα υπογραφής', noSignature: 'Χωρίς υπογραφή', signature: 'Υπογραφή', color: 'Χρώμα', delete: 'Διαγραφή',
  undoSend: 'Χρόνος για αναίρεση αποστολής', seconds: 'δευτ.', off: 'Κλειστό', swipeLeft: 'Σάρωση αριστερά', swipeRight: 'Σάρωση δεξιά',
  sw_archive: 'Αρχειοθέτηση', sw_trash: 'Κάδος', sw_flag: 'Αστέρι', sw_seen: 'Διαβασμένο / αδιάβαστο', sw_none: 'Τίποτα',
  opFailed: 'Ο server δεν δέχτηκε την αλλαγή', earlier: 'προηγούμενα', done: 'Τέλος', saved: 'Αποθηκεύτηκε',
  allInboxes: 'Όλα τα εισερχόμενα', inbox: 'Εισερχόμενα', sent: 'Απεσταλμένα', drafts: 'Πρόχειρα', trash: 'Κάδος', spam: 'Ανεπιθύμητα',
  archive: 'Αρχείο', all: 'Όλα τα μηνύματα', flagged: 'Με αστέρι', folders: 'Φάκελοι',
  addAccount: 'Προσθήκη λογαριασμού', welcome: 'Καλώς ήρθες στο RoarMail', welcomeSub: 'Σύνδεσε το email σου. Ο κωδικός μένει μόνο σε αυτόν τον υπολογιστή, στο κλειδοθήκη του συστήματος.',
  name: 'Όνομα', namePh: 'Όπως θα το βλέπουν οι παραλήπτες', email: 'Email', password: 'Κωδικός', next: 'Συνέχεια', connect: 'Σύνδεση', back: 'Πίσω', cancel: 'Άκυρο',
  checking: 'Αναζήτηση ρυθμίσεων…', testing: 'Σύνδεση με τον server…', advanced: 'Ρυθμίσεις server', incoming: 'Εισερχόμενα (IMAP)', outgoing: 'Εξερχόμενα (SMTP)',
  host: 'Server', port: 'Θύρα', security: 'Ασφάλεια', username: 'Όνομα χρήστη',
  err_auth: 'Λάθος email ή κωδικός. Αν έχεις επαλήθευση δύο βημάτων, χρειάζεσαι κωδικό εφαρμογής.',
  err_host: 'Δεν βρέθηκε ο server. Έλεγξε τις ρυθμίσεις server.', err_network: 'Δεν απαντά ο server. Έλεγξε τη σύνδεση και τις θύρες.',
  err_certificate: 'Το πιστοποιητικό του server δεν ταιριάζει με το όνομά του. Δοκίμασε το όνομα του server του παρόχου σου.',
  err_duplicate: 'Αυτός ο λογαριασμός υπάρχει ήδη.',
  hint_gmail: 'Το Gmail θέλει κωδικό εφαρμογής: Λογαριασμός Google › Ασφάλεια › Κωδικοί εφαρμογών.',
  hint_microsoft: 'Το Outlook.com και το Microsoft 365 μπορεί να ζητούν σύνδεση μέσω Microsoft, που έρχεται σύντομα. Αν έχεις κωδικό εφαρμογής, βάλε αυτόν.',
  hint_icloud: 'Το iCloud θέλει κωδικό εφαρμογής: appleid.apple.com › Κωδικοί εφαρμογών.',
  hint_yahoo: 'Το Yahoo θέλει κωδικό εφαρμογής από τις ρυθμίσεις ασφαλείας του λογαριασμού.',
  search: 'Αναζήτηση', searchResults: 'Αποτελέσματα', noResults: 'Δεν βρέθηκε τίποτα',
  empty: 'Τίποτα εδώ', inboxZero: 'Άδειο inbox. Μπράβο.', pickMessage: 'Διάλεξε ένα μήνυμα',
  compose: 'Νέο μήνυμα', reply: 'Απάντηση', replyAll: 'Απάντηση σε όλους', forward: 'Προώθηση', archiveIt: 'Αρχειοθέτηση', trashIt: 'Στον κάδο',
  flag: 'Αστέρι', unflag: 'Χωρίς αστέρι', markRead: 'Ως διαβασμένο', markUnread: 'Ως αδιάβαστο', refresh: 'Έλεγχος για νέα μηνύματα',
  from: 'Από', to: 'Προς', cc: 'Κοιν.', bcc: 'Ιδιαίτ.', subject: 'Θέμα', send: 'Αποστολή', sending: 'Αποστολή…', attach: 'Συνημμένο', discard: 'Απόρριψη',
  sent_ok: 'Το μήνυμα στάλθηκε', noRecipient: 'Βάλε τουλάχιστον έναν παραλήπτη.', discardQ: 'Να απορριφθεί το μήνυμα;',
  images: 'Οι εικόνες από το διαδίκτυο είναι κρυφές για να μη σε παρακολουθούν.', showImages: 'Εμφάνιση', alwaysImages: 'Πάντα από αυτόν τον αποστολέα',
  unsubscribe: 'Διαγραφή από τη λίστα', save: 'Αποθήκευση', open: 'Άνοιγμα', noSubject: '(χωρίς θέμα)', me: 'εμένα',
  offline: 'Χωρίς σύνδεση', connecting: 'Σύνδεση…', error: 'Σφάλμα', removeAccount: 'Αφαίρεση λογαριασμού', removeQ: 'Να αφαιρεθεί ο λογαριασμός από το RoarMail; Τα μηνύματα μένουν στον server.',
  updateReady: 'Νέα έκδοση έτοιμη', restart: 'Επανεκκίνηση', wrote: 'έγραψε', original: 'Αρχικό μήνυμα', today: 'Σήμερα', yesterday: 'Χθες',
  shortcuts: 'Συντομεύσεις: C νέο · R απάντηση · A σε όλους · F προώθηση · E αρχείο · # κάδος · M μετακίνηση · S αστέρι · U αδιάβαστο · Z αναίρεση · / αναζήτηση',
}
const en: typeof el = {
  appearance: 'Appearance', ap_system: 'Automatic, like the system', ap_dark: 'Dark', ap_light: 'Light',
  privacy: 'Privacy', blockTrackers: 'Block tracking pixels (even when images are shown)', stripTracking: 'Clean utm and similar tags off links',
  appLock: 'Lock with Touch ID', lockAfter: 'Lock after', minutes: 'minutes', onlySleep: 'Only at start and after sleep', lockNow: 'Lock now',
  lockUnavailable: 'Needs a Mac with Touch ID. Windows Hello is coming.', blockedSenders: 'Blocked senders', noneBlocked: 'None',
  unblock: 'Unblock', blockSender: 'Block sender', unblockSender: 'Unblock sender',
  blockQ: "This sender's next messages will go straight to Trash.", blockedNote: 'Blocked: their next messages go to Trash.',
  unsubscribeOne: 'Unsubscribe (one click)', unsubscribeQ: 'Stop the messages from this list?',
  unsubDone: 'Unsubscribed.', unsubSent: 'Unsubscribe request sent.', unsubOpened: 'The unsubscribe page opened in your browser.', unsubNone: 'This list offers no way to unsubscribe.',
  tracker1: '1 tracker blocked', trackersN: 'trackers blocked',
  sec_auth: 'Careful: your server could not confirm this message really came from this sender.',
  sec_name: "The sender's name shows a different address from the real one.", sec_reply: 'Replies will go to',
  linkCheck: 'Check this link', linkGoesTo: 'This link goes to', copyLink: 'Copy', openAnyway: 'Open anyway',
  lw_mismatch: 'The link text shows a different site from the one it opens.', lw_lookalike: 'The address uses letters that look Latin but are not.',
  lw_ip: 'The link goes to a number address instead of a site name.', lw_insecure: 'The connection is not encrypted (http).',
  locked: 'RoarMail is locked', unlock: 'Unlock',
  undo: 'Undo', archived: 'Archived', trashed: 'Moved to Trash', moved: 'Moved', deleted: 'Deleted',
  sentIn: 'Sending', sendFailed: 'Not sent', retry: 'Retry', edit: 'Edit', outboxWaiting: 'waiting in the Outbox',
  moveTo: 'Move to…', moveFilter: 'Type a folder name', selected: 'selected', selectAll: 'Select all',
  messages: 'messages', saveDraft: 'Save draft', draftSaved: 'Saved to Drafts', keepWriting: 'Keep writing',
  settings: 'Settings', accounts: 'Accounts', signatures: 'Signatures', general: 'General', newSignature: 'New signature',
  signatureName: 'Signature name', noSignature: 'No signature', signature: 'Signature', color: 'Color', delete: 'Delete',
  undoSend: 'Time to undo sending', seconds: 'sec', off: 'Off', swipeLeft: 'Swipe left', swipeRight: 'Swipe right',
  sw_archive: 'Archive', sw_trash: 'Trash', sw_flag: 'Star', sw_seen: 'Read / unread', sw_none: 'Nothing',
  opFailed: 'The server did not accept the change', earlier: 'earlier', done: 'Done', saved: 'Saved',
  allInboxes: 'All Inboxes', inbox: 'Inbox', sent: 'Sent', drafts: 'Drafts', trash: 'Trash', spam: 'Junk',
  archive: 'Archive', all: 'All Mail', flagged: 'Starred', folders: 'Folders',
  addAccount: 'Add account', welcome: 'Welcome to RoarMail', welcomeSub: 'Connect your email. Your password stays on this computer only, in the system keychain.',
  name: 'Name', namePh: 'As recipients will see it', email: 'Email', password: 'Password', next: 'Continue', connect: 'Connect', back: 'Back', cancel: 'Cancel',
  checking: 'Looking up settings…', testing: 'Connecting to the server…', advanced: 'Server settings', incoming: 'Incoming (IMAP)', outgoing: 'Outgoing (SMTP)',
  host: 'Server', port: 'Port', security: 'Security', username: 'Username',
  err_auth: 'Wrong email or password. With two-step verification on, you need an app password.',
  err_host: 'Server not found. Check the server settings.', err_network: 'The server does not answer. Check your connection and the ports.',
  err_certificate: "The server's certificate does not match its name. Try your provider's server name.",
  err_duplicate: 'This account is already added.',
  hint_gmail: 'Gmail needs an app password: Google Account › Security › App passwords.',
  hint_microsoft: 'Outlook.com and Microsoft 365 may require Microsoft sign-in, coming soon. If you have an app password, use it.',
  hint_icloud: 'iCloud needs an app password: appleid.apple.com › App-Specific Passwords.',
  hint_yahoo: "Yahoo needs an app password from your account's security settings.",
  search: 'Search', searchResults: 'Results', noResults: 'Nothing found',
  empty: 'Nothing here', inboxZero: 'Inbox zero. Well done.', pickMessage: 'Pick a message',
  compose: 'New message', reply: 'Reply', replyAll: 'Reply all', forward: 'Forward', archiveIt: 'Archive', trashIt: 'Trash',
  flag: 'Star', unflag: 'Unstar', markRead: 'Mark as read', markUnread: 'Mark as unread', refresh: 'Check for new mail',
  from: 'From', to: 'To', cc: 'Cc', bcc: 'Bcc', subject: 'Subject', send: 'Send', sending: 'Sending…', attach: 'Attach', discard: 'Discard',
  sent_ok: 'Message sent', noRecipient: 'Add at least one recipient.', discardQ: 'Discard this message?',
  images: 'Images from the web are hidden so senders cannot track you.', showImages: 'Show', alwaysImages: 'Always from this sender',
  unsubscribe: 'Unsubscribe', save: 'Save', open: 'Open', noSubject: '(no subject)', me: 'me',
  offline: 'Offline', connecting: 'Connecting…', error: 'Error', removeAccount: 'Remove account', removeQ: 'Remove this account from RoarMail? Your mail stays on the server.',
  updateReady: 'New version ready', restart: 'Restart', wrote: 'wrote', original: 'Original message', today: 'Today', yesterday: 'Yesterday',
  shortcuts: 'Shortcuts: C new · R reply · A reply all · F forward · E archive · # trash · M move · S star · U unread · Z undo · / search',
}

export const lang = (navigator.language || 'en').toLowerCase().startsWith('el') ? 'el' : 'en'
export const t = lang === 'el' ? el : en
export type Key = keyof typeof el

export function when(ms: number): string {
  const d = new Date(ms), n = new Date()
  const loc = lang === 'el' ? 'el-GR' : undefined
  if (d.toDateString() === n.toDateString()) return d.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' })
  const y = new Date(n); y.setDate(n.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return t.yesterday
  if (n.getTime() - ms < 6 * 864e5) return d.toLocaleDateString(loc, { weekday: 'short' })
  return d.toLocaleDateString(loc, { day: 'numeric', month: 'short', ...(d.getFullYear() !== n.getFullYear() ? { year: 'numeric' } : {}) })
}

export function fullDate(ms: number): string {
  return new Date(ms).toLocaleString(lang === 'el' ? 'el-GR' : undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

export function size(n: number): string {
  return n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`
}
