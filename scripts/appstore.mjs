// RoarMail for the Mac App Store and TestFlight (Alex, 19 Nov 2026). Runs in .github/workflows/appstore.yml on a Mac.
// It talks to App Store Connect with Alex's API key (repository secrets ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8; never in
// the repo), so nobody has to make certificates by hand in Xcode or Keychain:
//   node scripts/appstore.mjs prepare <dir>   the bundle id (made if missing), an Apple Distribution and a Mac Installer
//                                              Distribution certificate for keys made here (<dir>/app.key, installer.key),
//                                              written to <dir>/app.cer and installer.cer, and a Mac App Store profile
//                                              with that certificate, written to build/embedded.provisionprofile
//   node scripts/appstore.mjs tidy             the certificates and profiles an earlier run made are taken away (the
//                                              newest run's are kept, so a build still being processed keeps its own)
// What this script makes is named "RoarMail CI" (profiles), and the ids of its certificates go in each profile, so
// only what it made itself is ever taken away: a certificate Alex made in Xcode is never touched.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const BUNDLE = 'com.themadlions.roarmail'
const TAG = 'RoarMail CI'
const API = 'https://api.appstoreconnect.apple.com/v1'
const { ASC_KEY_ID: KID, ASC_ISSUER_ID: ISS, ASC_KEY_P8: P8 } = process.env
if (!KID || !ISS || !P8) {
  console.error('::error title=App Store key missing::Add the repository secrets ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_P8 (README, App Store).')
  process.exit(1)
}

const b64url = (b) => Buffer.from(b).toString('base64url')
function token() {
  const now = Math.floor(Date.now() / 1000)
  const head = b64url(JSON.stringify({ alg: 'ES256', kid: KID, typ: 'JWT' }))
  const body = b64url(JSON.stringify({ iss: ISS, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' }))
  const key = crypto.createPrivateKey(P8.includes('BEGIN') ? P8 : `-----BEGIN PRIVATE KEY-----\n${P8}\n-----END PRIVATE KEY-----`)
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' })
  return `${head}.${body}.${b64url(sig)}`
}

async function asc(method, url, body) {
  const r = await fetch(url.startsWith('http') ? url : API + url, {
    method, headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  })
  if (r.status === 204) return null
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    // Apple puts the real reasons under meta.associatedErrors (what is missing on the page, and where)
    const assoc = (j.errors || []).flatMap((x) => Object.values(x.meta?.associatedErrors || {}).flat()).map((x) => `${x.code || ''} ${x.detail || x.title || ''}`.trim())
    const e = [...(j.errors || []).map((x) => `${x.title}: ${x.detail}`), ...assoc].join(' · ') || `HTTP ${r.status}`
    throw new Error(`${method} ${url}: ${e}`)
  }
  return j
}

async function bundleId() {
  const found = await asc('GET', `/bundleIds?filter[identifier]=${BUNDLE}&limit=20`)
  const have = (found.data || []).find((b) => b.attributes.identifier === BUNDLE)
  if (have) return have.id
  const made = await asc('POST', '/bundleIds', { data: { type: 'bundleIds', attributes: { identifier: BUNDLE, name: 'RoarMail', platform: 'MAC_OS' } } })
  console.log(`made the bundle id ${BUNDLE}`)
  return made.data.id
}

async function certificate(type, csrFile, outFile) {
  const csr = fs.readFileSync(csrFile, 'utf8').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  const make = () => asc('POST', '/certificates', { data: { type: 'certificates', attributes: { certificateType: type, csrContent: csr } } })
  let r
  try { r = await make() } catch (e) {
    // Apple allows one Mac Installer Distribution certificate per account (and a few Distribution ones), shared with
    // RoarMe's Mac build: when the limit stops a new one, the oldest of the same kind is revoked and it is tried again
    // (20 Nov 2026). Only distribution certificates of this one kind are touched.
    if (!/already have a current|maximum number of|as many/i.test(e.message || '')) throw e
    const list = ((await asc('GET', `/certificates?filter[certificateType]=${type}&limit=200`)).data || [])
      .sort((a, b) => String(a.attributes.expirationDate).localeCompare(String(b.attributes.expirationDate)))
    if (!list.length) throw e
    await asc('DELETE', `/certificates/${list[0].id}`)
    console.log(`revoked the oldest ${type} certificate (${list[0].id}) to make room`)
    r = await make()
  }
  fs.writeFileSync(outFile, Buffer.from(r.data.attributes.certificateContent, 'base64'))
  console.log(`made a ${type} certificate (${r.data.id})`)
  return r.data.id
}

async function prepare(dir) {
  const bid = await bundleId()
  const app = await certificate('DISTRIBUTION', path.join(dir, 'app.csr'), path.join(dir, 'app.cer'))
  const inst = await certificate('MAC_INSTALLER_DISTRIBUTION', path.join(dir, 'installer.csr'), path.join(dir, 'installer.cer'))
  const name = `${TAG} ${new Date().toISOString().slice(0, 16).replace('T', ' ')} ${app}:${inst}`
  const p = await asc('POST', '/profiles', { data: { type: 'profiles', attributes: { name, profileType: 'MAC_APP_STORE' },
    relationships: { bundleId: { data: { type: 'bundleIds', id: bid } }, certificates: { data: [{ type: 'certificates', id: app }] } } } })
  fs.writeFileSync('build/embedded.provisionprofile', Buffer.from(p.data.attributes.profileContent, 'base64'))
  console.log(`made the profile "${name}"`)
}

async function tidy() {
  const all = await asc('GET', '/profiles?limit=200&fields[profiles]=name,createdDate')
  const ours = (all.data || []).filter((p) => String(p.attributes.name || '').startsWith(TAG))
    .sort((a, b) => String(b.attributes.name).localeCompare(String(a.attributes.name)))
  for (const p of ours.slice(1)) {
    const ids = (String(p.attributes.name).match(/ (\w+):(\w+)$/) || []).slice(1)
    for (const id of ids) await asc('DELETE', `/certificates/${id}`).then(() => console.log(`took away certificate ${id}`)).catch((e) => console.log(`(certificate ${id}: ${e.message})`))
    await asc('DELETE', `/profiles/${p.id}`).then(() => console.log(`took away profile "${p.attributes.name}"`)).catch((e) => console.log(`(profile: ${e.message})`))
  }
}

/** what Apple made of the uploads, and every build that is ready put in every TestFlight group (internal testers see
 *  nothing until a build is in their group). Waits up to `minutes` for the newest to finish processing. */
async function distribute(minutes = 25) {
  const apps = await asc('GET', `/apps?filter[bundleId]=${BUNDLE}`)
  const app = apps.data?.[0]
  if (!app) throw new Error(`no app with the bundle ID ${BUNDLE} in App Store Connect yet`)
  const until = Date.now() + minutes * 60e3
  let builds
  for (;;) {
    builds = (await asc('GET', `/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=10&fields[builds]=version,processingState,uploadedDate,expired`)).data || []
    const newest = builds[0]
    for (const b of builds) console.log(`build ${b.attributes.version}: ${b.attributes.processingState}${b.attributes.expired ? ' (expired)' : ''}, uploaded ${b.attributes.uploadedDate}`)
    if (!newest || newest.attributes.processingState !== 'PROCESSING' || Date.now() > until) break
    console.log('Apple is still processing the newest build; looking again in a minute')
    await new Promise((r) => setTimeout(r, 60e3))
  }
  const bad = builds.filter((b) => b.attributes.processingState === 'INVALID' || b.attributes.processingState === 'FAILED')
  if (bad.length) console.log(`::warning title=Builds Apple refused::${bad.map((b) => b.attributes.version).join(', ')}. Apple says why in an email to the account holder.`)
  const ready = builds.filter((b) => b.attributes.processingState === 'VALID' && !b.attributes.expired)
  // what TestFlight itself says of each ready build (Missing export compliance, ready to test, …)
  for (const b of ready) {
    const d = await asc('GET', `/builds/${b.id}/buildBetaDetail`).catch(() => null)
    if (d?.data) console.log(`build ${b.attributes.version} for testers: internal ${d.data.attributes.internalBuildState}, external ${d.data.attributes.externalBuildState}`)
    // RoarMail uses only the system's standard encryption (TLS to mail servers): exempt, said once per build
    if (d?.data && d.data.attributes.internalBuildState === 'MISSING_EXPORT_COMPLIANCE') {
      await asc('PATCH', `/builds/${b.id}`, { data: { type: 'builds', id: b.id, attributes: { usesNonExemptEncryption: false } } })
        .then(() => console.log(`build ${b.attributes.version}: export compliance answered (standard encryption only)`))
        .catch((e) => console.log(`(build ${b.attributes.version}: ${e.message})`))
    }
  }
  const groups = (await asc('GET', `/apps/${app.id}/betaGroups?limit=50`)).data || []
  for (const g of groups) console.log(`group "${g.attributes.name}": internal ${g.attributes.isInternalGroup}, gets every build by itself ${g.attributes.hasAccessToAllBuilds}`)
  if (!groups.length) console.log('::warning::no TestFlight group yet: App Store Connect > TestFlight > Internal Testing > +')
  for (const g of groups) {
    if (!ready.length || g.attributes.hasAccessToAllBuilds) continue
    await asc('POST', `/betaGroups/${g.id}/relationships/builds`, { data: ready.map((b) => ({ type: 'builds', id: b.id })) })
      .then(() => console.log(`group "${g.attributes.name}": ${ready.map((b) => b.attributes.version).join(', ')} in it`))
      .catch((e) => console.log(`(group "${g.attributes.name}": ${e.message})`))
  }
  if (!ready.length) console.log('::warning::no build is ready for testers yet')
  // where the App Store version stands (Waiting for Review, In Review, Ready for Distribution, Rejected…)
  const vs = (await asc('GET', `/apps/${app.id}/appStoreVersions?filter[platform]=MAC_OS&limit=5`).catch(() => null))?.data || []
  for (const v of vs) console.log(`App Store version ${v.attributes.versionString}: ${v.attributes.appVersionState || v.attributes.appStoreState}`)
  const subs = (await asc('GET', `/reviewSubmissions?filter[app]=${app.id}&limit=5`).catch(() => null))?.data || []
  for (const x of subs) console.log(`review submission ${x.attributes.submittedDate || '(not sent)'}: ${x.attributes.state}`)
}

// ---------- the App Store page (Alex, 19 Nov 2026: "now we can put it out on the App Store") ----------
const LISTING = {
  subtitle: 'Private mail for all accounts',
  privacyPolicyUrl: 'https://themadlions.com/legal/roarmail/#privacy',
  supportUrl: 'https://themadlions.com/lab/roarmail/',
  marketingUrl: 'https://themadlions.com/lab/roarmail/',
  copyright: '2026 The Mad Lions',
  keywords: 'mail,email,inbox,imap,gmail,outlook,privacy,unified,snooze,spam',
  promotionalText: 'Every mail account in one calm, fast window. Your mail stays between your Mac and your servers.',
  description: `RoarMail brings every mail account into one calm, fast window: Gmail, Outlook, iCloud and any IMAP account. Your mail stays between your Mac and your servers.

UNIFIED INBOX
All your accounts together, or one at a time, with their own colours.

WORK THE WAY YOU WANT
• Snooze a message until the time you need it
• Send later, and undo send
• Waiting for a reply: the mail you sent that nobody has answered yet
• Rules, signatures and templates
• Files: every attachment from every message in one place
• Contacts with photos, VIP and groups

SAFE
• Blocking that stops fake banks and couriers, whatever address they come from
• Pictures from senders you do not know stay off until you allow them
• Tracking links and pixels removed

WITH YOUR ROAR ACCOUNT (optional)
• Your setup on every Mac
• Projects, calendar and tasks across The Mad Lions' apps

Made in Athens by The Mad Lions.`,
  reviewNotes: `RoarMail is an email app: it needs a mail account to show anything.
A test mailbox is in the sign-in fields above (an IMAP account at themadlions.com).

How to try it:
1. Open RoarMail and choose Add Account.
2. Type the email address and the password from the fields above and press Add. The server is found by itself.
3. The inbox has a few test messages, among them one with a PDF and a picture, one with a calendar invitation (Accept / Decline appear on it) and one with a photo.

The Roar Account (Settings > Roar Account) is optional and not needed to use the app.
RoarMail AI (the ✦ button when writing) asks for permission before any text is sent, and needs a Roar Account; it is optional.
RoarMail uses only standard encryption (TLS to mail servers).`,
}

async function appOf() {
  const apps = await asc('GET', `/apps?filter[bundleId]=${BUNDLE}`)
  const app = apps.data?.[0]
  if (!app) throw new Error(`no app with the bundle ID ${BUNDLE} in App Store Connect yet`)
  return app
}
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex')
const soft = (what, p) => p.then((r) => { console.log(`✓ ${what}`); return r }).catch((e) => { console.log(`::warning title=${what}::${e.message}`); return null })

async function editableVersion(app) {
  const vs = (await asc('GET', `/apps/${app.id}/appStoreVersions?filter[platform]=MAC_OS&limit=10`)).data || []
  const open = vs.find((v) => ['PREPARE_FOR_SUBMISSION', 'DEVELOPER_REJECTED', 'REJECTED', 'METADATA_REJECTED', 'INVALID_BINARY'].includes(v.attributes.appStoreState || v.attributes.appVersionState))
  return open || vs[0]
}

async function listing(shotsDir) {
  const app = await appOf()
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version
  // the app's information: subtitle, privacy policy, category, age rating
  const infos = (await asc('GET', `/apps/${app.id}/appInfos`)).data || []
  const info = infos.find((i) => !['READY_FOR_DISTRIBUTION', 'READY_FOR_SALE'].includes(i.attributes.appStoreState || i.attributes.state)) || infos[0]
  if (info) {
    const locs = (await asc('GET', `/appInfos/${info.id}/appInfoLocalizations`)).data || []
    const en = locs.find((l) => l.attributes.locale.startsWith('en')) || locs[0]
    if (en) await soft('subtitle and privacy policy', asc('PATCH', `/appInfoLocalizations/${en.id}`, { data: { type: 'appInfoLocalizations', id: en.id, attributes: { subtitle: LISTING.subtitle, privacyPolicyUrl: LISTING.privacyPolicyUrl } } }))
    await soft('category Productivity', asc('PATCH', `/appInfos/${info.id}`, { data: { type: 'appInfos', id: info.id, relationships: { primaryCategory: { data: { type: 'appCategories', id: 'PRODUCTIVITY' } } } } }))
    let ar = await asc('GET', `/appInfos/${info.id}/ageRatingDeclaration`).catch((e) => { console.log(`(age rating through the app info: ${e.message})`); return null })
    if (!ar?.data) {
      const vv = await editableVersion(app)
      if (vv) ar = await asc('GET', `/appStoreVersions/${vv.id}/ageRatingDeclaration`).catch((e) => { console.log(`(age rating through the version: ${e.message})`); return null })
    }
    if (!ar?.data) console.log('::warning title=age rating::App Store Connect gave no age rating form')
    if (ar?.data) {
      // Apple's 2025 questions, all at once (one at a time saves nothing): a mail app shows nothing of its own, so
      // "none" / "no"; it does carry messages between people (mail), so messagingAndChat is yes. Where Apple says a
      // field wants the other kind of answer, it is turned ("NONE" <-> false) and sent again.
      const attrs = {
        alcoholTobaccoOrDrugUseOrReferences: 'NONE', contests: 'NONE', gamblingSimulated: 'NONE', horrorOrFearThemes: 'NONE',
        matureOrSuggestiveThemes: 'NONE', medicalOrTreatmentInformation: 'NONE', profanityOrCrudeHumor: 'NONE',
        sexualContentGraphicAndNudity: 'NONE', sexualContentOrNudity: 'NONE', violenceCartoonOrFantasy: 'NONE',
        violenceRealistic: 'NONE', violenceRealisticProlongedGraphicOrSadistic: 'NONE', gunsOrOtherWeapons: 'NONE',
        gambling: false, unrestrictedWebAccess: false, lootBox: false, advertising: false, parentalControls: false,
        ageAssurance: false, userGeneratedContent: false, healthOrWellnessTopics: false, messagingAndChat: true,
      }
      for (let n = 0; n < 40; n++) {
        try {
          await asc('PATCH', `/ageRatingDeclarations/${ar.data.id}`, { data: { type: 'ageRatingDeclarations', id: ar.data.id, attributes: attrs } })
          console.log('✓ age rating answered'); break
        } catch (e) {
          const m = String(e.message)
          // a question Apple added that we did not know: answered "no" (turned to "NONE" next round if it wants that)
          const missing = /missing a required attribute|must provide a value/i.test(m) ? [...m.matchAll(/'(\w+)'/g)].map((x) => x[1]).filter((k) => !(k in attrs)) : []
          if (missing.length) { for (const k of missing) attrs[k] = false; continue }
          const bad = [...m.matchAll(/'(\w+)'/g)].map((x) => x[1]).filter((k) => k in attrs)
          const unknown = [...m.matchAll(/(?:not (?:a )?(?:valid|allowed|recognized)[^'"]*|unknown[^'"]*)['"](\w+)['"]/gi)].map((x) => x[1])
          if (!bad.length && !unknown.length) { console.log(`::warning title=age rating::${m}`); break }
          for (const k of unknown) delete attrs[k]
          for (const k of bad) {
            if (/not allowed|is not a valid attribute|unknown/i.test(m) && !/value/i.test(m)) delete attrs[k]
            else attrs[k] = typeof attrs[k] === 'boolean' ? 'NONE' : attrs[k] === 'NONE' ? false : attrs[k]
          }
        }
      }
    }
  }
  await soft('content rights', asc('PATCH', `/apps/${app.id}`, { data: { type: 'apps', id: app.id, attributes: { contentRightsDeclaration: 'DOES_NOT_USE_THIRD_PARTY_CONTENT' } } }))
  // the version: its number, copyright, texts, the build, the notes for the reviewer
  let v = await editableVersion(app)
  if (!v) v = (await asc('POST', '/appStoreVersions', { data: { type: 'appStoreVersions', attributes: { platform: 'MAC_OS', versionString: version }, relationships: { app: { data: { type: 'apps', id: app.id } } } } })).data
  await soft(`version ${version}`, asc('PATCH', `/appStoreVersions/${v.id}`, { data: { type: 'appStoreVersions', id: v.id, attributes: { versionString: version, copyright: LISTING.copyright } } }))
  const vlocs = (await asc('GET', `/appStoreVersions/${v.id}/appStoreVersionLocalizations`)).data || []
  const vl = vlocs.find((l) => l.attributes.locale.startsWith('en')) || vlocs[0]
  if (vl) await soft('description, keywords, links', asc('PATCH', `/appStoreVersionLocalizations/${vl.id}`, { data: { type: 'appStoreVersionLocalizations', id: vl.id,
    attributes: { description: LISTING.description, keywords: LISTING.keywords, supportUrl: LISTING.supportUrl, marketingUrl: LISTING.marketingUrl, promotionalText: LISTING.promotionalText } } }))
  const builds = (await asc('GET', `/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=20&fields[builds]=version,processingState,expired&include=preReleaseVersion`))
  const pre = new Map((builds.included || []).map((x) => [x.id, x.attributes.version]))
  const build = (builds.data || []).find((b) => b.attributes.processingState === 'VALID' && !b.attributes.expired && pre.get(b.relationships?.preReleaseVersion?.data?.id) === version)
    || (builds.data || []).find((b) => b.attributes.processingState === 'VALID' && !b.attributes.expired)
  if (build) await soft(`build ${build.attributes.version} chosen`, asc('PATCH', `/appStoreVersions/${v.id}/relationships/build`, { data: { type: 'builds', id: build.id } }))
  if (build) await soft(`build ${build.attributes.version}: standard encryption only`, asc('PATCH', `/builds/${build.id}`, { data: { type: 'builds', id: build.id, attributes: { usesNonExemptEncryption: false } } }))
  else console.log('::warning::no ready build to choose yet')
  const rd = await asc('GET', `/appStoreVersions/${v.id}/appStoreReviewDetail`).catch(() => null)
  if (rd?.data) await soft('notes for the reviewer', asc('PATCH', `/appStoreReviewDetails/${rd.data.id}`, { data: { type: 'appStoreReviewDetails', id: rd.data.id, attributes: { notes: LISTING.reviewNotes } } }))
  else await soft('notes for the reviewer', asc('POST', '/appStoreReviewDetails', { data: { type: 'appStoreReviewDetails', attributes: { notes: LISTING.reviewNotes }, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: v.id } } } } }))
  // free
  // a schedule can exist with no price in it: look at its prices, not only at it
  const prices = await asc('GET', `/apps/${app.id}/appPriceSchedule/manualPrices?limit=5`).catch(() => null)
  if (!(prices?.data || []).length) {
    const pts = (await asc('GET', `/apps/${app.id}/appPricePoints?filter[territory]=USA&limit=200`).catch(() => null))?.data || []
    const free = pts.find((p) => Number(p.attributes.customerPrice) === 0)
    if (free) await soft('price: free', asc('POST', '/appPriceSchedules', { data: { type: 'appPriceSchedules', relationships: {
      app: { data: { type: 'apps', id: app.id } }, baseTerritory: { data: { type: 'territories', id: 'USA' } }, manualPrices: { data: [{ type: 'appPrices', id: '${p0}' }] } } },
      included: [{ type: 'appPrices', id: '${p0}', attributes: { startDate: null }, relationships: { appPricePoint: { data: { type: 'appPricePoints', id: free.id } } } }] }))
  } else console.log('✓ price already set')
  if (!(prices?.data || []).length) console.log('(price: no manual price was there)')
  // the pictures (2880 x 1800), in place of any there before
  if (shotsDir && vl && fs.existsSync(shotsDir)) {
    const files = fs.readdirSync(shotsDir).filter((f) => f.endsWith('.png')).sort()
    if (files.length) {
      const sets = (await asc('GET', `/appStoreVersionLocalizations/${vl.id}/appScreenshotSets`)).data || []
      let set = sets.find((x) => x.attributes.screenshotDisplayType === 'APP_DESKTOP')
      if (!set) set = (await asc('POST', '/appScreenshotSets', { data: { type: 'appScreenshotSets', attributes: { screenshotDisplayType: 'APP_DESKTOP' },
        relationships: { appStoreVersionLocalization: { data: { type: 'appStoreVersionLocalizations', id: vl.id } } } } })).data
      for (const old of (await asc('GET', `/appScreenshotSets/${set.id}/appScreenshots`)).data || []) await asc('DELETE', `/appScreenshots/${old.id}`).catch(() => {})
      for (const f of files) {
        const buf = fs.readFileSync(path.join(shotsDir, f))
        const r = (await asc('POST', '/appScreenshots', { data: { type: 'appScreenshots', attributes: { fileName: f, fileSize: buf.length },
          relationships: { appScreenshotSet: { data: { type: 'appScreenshotSets', id: set.id } } } } })).data
        for (const op of r.attributes.uploadOperations || []) {
          const headers = Object.fromEntries((op.requestHeaders || []).map((h) => [h.name, h.value]))
          const put = await fetch(op.url, { method: op.method, headers, body: buf.subarray(op.offset, op.offset + op.length) })
          if (!put.ok) throw new Error(`screenshot ${f}: upload ${put.status}`)
        }
        await asc('PATCH', `/appScreenshots/${r.id}`, { data: { type: 'appScreenshots', id: r.id, attributes: { uploaded: true, sourceFileChecksum: md5(buf) } } })
        console.log(`✓ screenshot ${f}`)
      }
    }
  }
  console.log('::notice title=App Store page::Filled. Still by hand in App Store Connect: App Privacy, and the review sign-in (already done by Alex).')
}

async function submit() {
  const app = await appOf()
  const v = await editableVersion(app)
  if (!v) throw new Error('no version to send')
  console.log(`version ${v.attributes.versionString}: ${v.attributes.appStoreState || v.attributes.appVersionState || '?'}`)
  // a submission App Review sent back (unresolved issues) cannot take a changed build: it is cancelled and a fresh one
  // is made (20 Nov 2026, after the network.server rejection)
  const back = ((await asc('GET', `/reviewSubmissions?filter[app]=${app.id}&filter[platform]=MAC_OS&filter[state]=UNRESOLVED_ISSUES`).catch(() => null))?.data || [])
  for (const b of back) {
    await asc('PATCH', `/reviewSubmissions/${b.id}`, { data: { type: 'reviewSubmissions', id: b.id, attributes: { canceled: true } } })
    console.log(`cancelled the sent-back submission ${b.id}`)
    for (let i = 0; i < 36; i++) {
      const st = (await asc('GET', `/reviewSubmissions/${b.id}`)).data.attributes.state
      if (st !== 'CANCELING') { console.log(`it is now ${st}`); break }
      await new Promise((ok) => setTimeout(ok, 5000))
    }
  }
  // an unsent submission from an earlier try is used again (Apple allows one open at a time)
  const open = ((await asc('GET', `/reviewSubmissions?filter[app]=${app.id}&filter[platform]=MAC_OS&filter[state]=READY_FOR_REVIEW&include=items`).catch(() => null))?.data || [])[0]
  const sub = open || (await asc('POST', '/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: 'MAC_OS' }, relationships: { app: { data: { type: 'apps', id: app.id } } } } })).data
  const has = (open?.relationships?.items?.data || []).length > 0
  if (!has) await asc('POST', '/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: {
    reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } }, appStoreVersion: { data: { type: 'appStoreVersions', id: v.id } } } } })
  await asc('PATCH', `/reviewSubmissions/${sub.id}`, { data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } } })
  console.log(`::notice title=Sent for review::RoarMail ${v.attributes.versionString} is with Apple's App Review.`)
}

const [cmd, arg] = process.argv.slice(2)
try {
  if (cmd === 'prepare') await prepare(arg || '.')
  else if (cmd === 'tidy') await tidy()
  else if (cmd === 'distribute') await distribute(Number(arg) || 25)
  else if (cmd === 'listing') await listing(arg)
  else if (cmd === 'submit') await submit()
  else throw new Error('use: prepare <dir> | tidy | distribute [minutes] | listing [screenshots dir] | submit')
} catch (e) {
  const m = String(e.message || e)
  const hint = /maximum|limit|already have a current/i.test(m)
    ? ' The account has as many distribution certificates as Apple allows: revoke an old one at developer.apple.com > Certificates.'
    : /forbidden|not allowed|NOT_AUTHORIZED|403/i.test(m) ? ' The API key needs the Admin role (App Store Connect > Users and Access > Integrations).' : ''
  console.error(`::error title=App Store Connect::${m}${hint}`)
  process.exit(1)
}
