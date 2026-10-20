import type { MailApi } from '../shared/api'

declare global {
  interface Window {
    roarmail: MailApi & {
      update: {
        state(): Promise<{ status: string; version: string; progress: number }>
        install(): Promise<boolean>
        on(cb: (s: { status: string; version: string; progress: number }) => void): () => void
      }
    }
  }
}
export {}
