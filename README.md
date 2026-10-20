# RoarMail

A desktop mail client for Mac and Windows, in the THEMADLIONS look. TheMadlions Lab, Experiment 03.

- Talks IMAP and SMTP straight from your computer to your own mail servers. No RoarMail server sees your mail.
- Passwords live in the system key store (Keychain on Mac, DPAPI on Windows).
- Mail is cached in a local SQLite database for offline reading and fast search.

## Layout

- `src/main` the mail engine (imapflow, nodemailer, mailparser, better-sqlite3), window, updater
- `src/preload` the desktop implementation of `MailApi`
- `src/shared/api.ts` `MailApi`, the only door between the screens and mail (a Hub version can implement it later)
- `src/renderer` the screens (React)
- `docs`: the feature list and architecture are kept outside the repo

## Build

`npm install`, then `npm start` to run, `npm run dist:mac` / `npm run dist:win` for installers.
Releases: bump `version` in package.json, push, then push a tag `desktop-vX.Y.Z`.
