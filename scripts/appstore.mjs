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
    const e = (j.errors || []).map((x) => `${x.title}: ${x.detail}`).join(' · ') || `HTTP ${r.status}`
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
  const r = await asc('POST', '/certificates', { data: { type: 'certificates', attributes: { certificateType: type, csrContent: csr } } })
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
    const ar = await asc('GET', `/appInfos/${info.id}/ageRatingDeclaration`).catch(() => null)
    if (ar?.data) {
      // nothing a mail app shows of its own: every question answered "none" / "no", one at a time so a field Apple
      // has renamed does not stop the others
      const none = ['alcoholTobaccoOrDrugUseOrReferences', 'contests', 'gamblingSimulated', 'horrorOrFearThemes', 'matureOrSuggestiveThemes',
        'medicalOrTreatmentInformation', 'profanityOrCrudeHumor', 'sexualContentGraphicAndNudity', 'sexualContentOrNudity',
        'violenceCartoonOrFantasy', 'violenceRealistic', 'violenceRealisticProlongedGraphicOrSadistic', 'gunsOrOtherWeapons', 'healthOrWellnessTopics']
      const no = ['gambling', 'unrestrictedWebAccess', 'lootBox', 'advertising', 'parentalControls', 'ageAssurance', 'userGeneratedContent', 'messagingAndChat']
      for (const k of none) await asc('PATCH', `/ageRatingDeclarations/${ar.data.id}`, { data: { type: 'ageRatingDeclarations', id: ar.data.id, attributes: { [k]: 'NONE' } } }).catch(() => {})
      for (const k of no) await asc('PATCH', `/ageRatingDeclarations/${ar.data.id}`, { data: { type: 'ageRatingDeclarations', id: ar.data.id, attributes: { [k]: false } } }).catch(() => {})
      console.log('✓ age rating answered')
    }
  }
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
  else console.log('::warning::no ready build to choose yet')
  const rd = await asc('GET', `/appStoreVersions/${v.id}/appStoreReviewDetail`).catch(() => null)
  if (rd?.data) await soft('notes for the reviewer', asc('PATCH', `/appStoreReviewDetails/${rd.data.id}`, { data: { type: 'appStoreReviewDetails', id: rd.data.id, attributes: { notes: LISTING.reviewNotes } } }))
  else await soft('notes for the reviewer', asc('POST', '/appStoreReviewDetails', { data: { type: 'appStoreReviewDetails', attributes: { notes: LISTING.reviewNotes }, relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: v.id } } } } }))
  // free
  const sched = await asc('GET', `/apps/${app.id}/appPriceSchedule`).catch(() => null)
  if (!sched?.data) {
    const pts = (await asc('GET', `/apps/${app.id}/appPricePoints?filter[territory]=USA&limit=200`).catch(() => null))?.data || []
    const free = pts.find((p) => Number(p.attributes.customerPrice) === 0)
    if (free) await soft('price: free', asc('POST', '/appPriceSchedules', { data: { type: 'appPriceSchedules', relationships: {
      app: { data: { type: 'apps', id: app.id } }, baseTerritory: { data: { type: 'territories', id: 'USA' } }, manualPrices: { data: [{ type: 'appPrices', id: '${p0}' }] } } },
      included: [{ type: 'appPrices', id: '${p0}', attributes: { startDate: null }, relationships: { appPricePoint: { data: { type: 'appPricePoints', id: free.id } } } }] }))
  } else console.log('✓ price already set')
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
  const sub = (await asc('POST', '/reviewSubmissions', { data: { type: 'reviewSubmissions', attributes: { platform: 'MAC_OS' }, relationships: { app: { data: { type: 'apps', id: app.id } } } } })).data
  await asc('POST', '/reviewSubmissionItems', { data: { type: 'reviewSubmissionItems', relationships: {
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
