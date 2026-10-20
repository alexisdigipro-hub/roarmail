// Passwords are encrypted with the operating system's own key store (Keychain on a Mac, DPAPI on Windows)
// before they touch the database, and are only ever decrypted here, in the main process.
import { safeStorage } from 'electron'

export function seal(secret: string): Buffer {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('The system key store is not available, so the password cannot be kept safely.')
  return safeStorage.encryptString(secret)
}

export function open(blob: Buffer | null | undefined): string {
  if (!blob) return ''
  return safeStorage.decryptString(Buffer.from(blob))
}
