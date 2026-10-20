// The desktop implementation of MailApi: each call goes over IPC to the main process.
// The page gets this object only; it never sees Node, the database or any password.
import { contextBridge, ipcRenderer } from 'electron'
import type { MailApi, MailEvent } from '../shared/api'

const call = (name: string) => (...args: unknown[]) => ipcRenderer.invoke(`mail:${name}`, ...args)

const api: MailApi & { update: Record<string, (...a: any[]) => any> } = {
  platform: process.platform,
  autodetect: call('autodetect') as MailApi['autodetect'],
  testAccount: call('testAccount') as MailApi['testAccount'],
  addAccount: call('addAccount') as MailApi['addAccount'],
  removeAccount: call('removeAccount') as MailApi['removeAccount'],
  accounts: call('accounts') as MailApi['accounts'],
  folders: call('folders') as MailApi['folders'],
  messages: call('messages') as MailApi['messages'],
  message: call('message') as MailApi['message'],
  search: call('search') as MailApi['search'],
  contacts: call('contacts') as MailApi['contacts'],
  act: call('act') as MailApi['act'],
  allowImages: call('allowImages') as MailApi['allowImages'],
  send: call('send') as MailApi['send'],
  pickFiles: call('pickFiles') as MailApi['pickFiles'],
  openAttachment: call('openAttachment') as MailApi['openAttachment'],
  saveAttachment: call('saveAttachment') as MailApi['saveAttachment'],
  openExternal: call('openExternal') as MailApi['openExternal'],
  refresh: call('refresh') as MailApi['refresh'],
  thread: call('thread') as MailApi['thread'],
  undo: call('undo') as MailApi['undo'],
  cancelSend: call('cancelSend') as MailApi['cancelSend'],
  retrySend: call('retrySend') as MailApi['retrySend'],
  outbox: call('outbox') as MailApi['outbox'],
  saveDraft: call('saveDraft') as MailApi['saveDraft'],
  discardDraft: call('discardDraft') as MailApi['discardDraft'],
  draftFromMessage: call('draftFromMessage') as MailApi['draftFromMessage'],
  updateAccount: call('updateAccount') as MailApi['updateAccount'],
  signatures: call('signatures') as MailApi['signatures'],
  saveSignature: call('saveSignature') as MailApi['saveSignature'],
  deleteSignature: call('deleteSignature') as MailApi['deleteSignature'],
  settings: call('settings') as MailApi['settings'],
  setSetting: call('setSetting') as MailApi['setSetting'],
  snooze: call('snooze') as MailApi['snooze'],
  snoozed: call('snoozed') as MailApi['snoozed'],
  unsnooze: call('unsnooze') as MailApi['unsnooze'],
  unsubscribe: call('unsubscribe') as MailApi['unsubscribe'],
  blockSender: call('blockSender') as MailApi['blockSender'],
  blockedSenders: call('blockedSenders') as MailApi['blockedSenders'],
  lockState: call('lockState') as MailApi['lockState'],
  unlock: call('unlock') as MailApi['unlock'],
  lockNow: call('lockNow') as MailApi['lockNow'],
  on(cb) {
    const h = (_e: unknown, ev: MailEvent) => cb(ev)
    ipcRenderer.on('mail:event', h)
    return () => { ipcRenderer.removeListener('mail:event', h) }
  },
  update: {
    state: () => ipcRenderer.invoke('mail:update-state'),
    install: () => ipcRenderer.invoke('mail:update-install'),
    on: (cb: (s: unknown) => void) => {
      const h = (_e: unknown, s: unknown) => cb(s)
      ipcRenderer.on('mail:update', h)
      return () => { ipcRenderer.removeListener('mail:update', h) }
    },
  },
}

contextBridge.exposeInMainWorld('roarmail', api)
