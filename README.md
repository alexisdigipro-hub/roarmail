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
- `src/main/rules.ts`, `src/main/ics.ts`, `src/renderer/templates.ts` plain functions (rules, calendar invitations and their iMIP replies, template placeholders), tested in `test/`
- `src/main/schema*.sql` the database steps, run in order by `store.ts`; an `add column` whose column is already there is skipped
- `docs`: the feature list and architecture are kept outside the repo

## Build

`npm install`, then `npm start` to run, `npm test` for the tests of the plain parts (rules, calendar invitations, templates; Node 22's own test runner), `npm run dist:mac` / `npm run dist:win` for installers.
Releases: bump `version` in package.json, push, then push a tag `desktop-vX.Y.Z`.

0.34.4: new icon (the Lab's one family of icons, 10 Nov 2026).

## App Store (Mac, TestFlight)

Since 0.36.0 RoarMail can also be built for the Mac App Store (Alex, 19 Nov 2026): `.github/workflows/appstore.yml`,
run from the Actions tab, builds the sandboxed universal app (`npm run dist:mas`, `build.mas` in package.json,
`build/entitlements.mas*.plist`), signs it and sends it to App Store Connect, where it shows in TestFlight.
`scripts/appstore.mjs` makes the certificates and the Mac App Store profile through the App Store Connect API for each
run and takes the older ones away, so nothing is kept by hand. In the store copy (`process.mas`) the own updater is off
(the App Store updates it) and Settings > About says so.

What it needs, once, from the account holder (never in the repo):
- an App Store Connect API key with the Admin role, as repository secrets `ASC_KEY_ID`, `ASC_ISSUER_ID` and `ASC_KEY_P8`
  (the whole .p8 file);
- the app in App Store Connect: Apps > + > New App > macOS, name RoarMail, bundle ID com.themadlions.roarmail (the first
  run registers the bundle ID if it is missing).
