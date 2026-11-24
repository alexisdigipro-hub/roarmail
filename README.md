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

0.37.0 (Alex, 19 Nov 2026): swipe, slide and glass everywhere. `src/renderer/swipe.ts` `useSwipeTabs` moves between tabs
and pages with a two-finger sideways swipe on the trackpad or a finger on a touch screen (Settings pages and their tabs,
an account's tabs, Contacts groups and a contact's tabs, Files kinds, Statistics accounts, the list's filter bar); never on
the message rows, in text fields or over something that scrolls sideways. New content slides in from its side
(`data-slide`), the sliding glass lens is on every choice group, lists and cards rise in, cards and menus have the glass
light (look.css, last block). All of it rests under Motion off, Power saving and Reduce motion.

0.38.0 (Alex, 19 Nov 2026: "it is quite heavy, make it not heavy at all"): the same app and look, lighter. Measured on a
made-up mailbox of 9 accounts and 50,000 messages: the 5-minute sweep of blocked senders held the window for 1.9 s and now
does nothing when no rule changed and no mail came (the first one after the update judges everything once, in small steps);
Junk is judged once per message (`shield_judged`, schema017), not on every sync (38 ms to 2 ms); Waiting for a reply is
counted only when mail came or went (56 ms to 0.1 ms on every count change) and its query uses an index (56 ms to 5 ms);
the list and the Promotions numbers are kept while nothing in the database changed; a folder check that found nothing new
tells the window nothing; "the list changed" events go to the window at most every 400 ms per account; compiled SQL is kept
(`store.ts keepStatements`); after sleep the accounts reconnect two at a time; rows out of sight are not drawn
(`content-visibility`); Settings, Files and Statistics load when first opened. Waiting for a reply is now a switch in
Settings > General > Inboxes, off until turned on.

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

## Mail in RoarMe (0.39.0, 24 Nov 2026)

Settings > Roar Account > My mail in RoarMe: Send to RoarMe hands one account's password (for Sign in with Microsoft, its
refresh token) to the Edge Function `roarmail-cloud` in RoarMe's Supabase project (`supabase/functions/roarmail-cloud`),
which checks it against the IMAP server and keeps it in Supabase Vault (`supabase/roarmail-cloud.sql`: `roarmail_cloud`,
read only by its owner and never with the secret). RoarMe's ROARMAIL folder then reads that account's mail over IMAP
through the function, on any device. Mail is not stored in the cloud. Remove from RoarMe deletes the secret.
