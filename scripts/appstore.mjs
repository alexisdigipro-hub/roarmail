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

const [cmd, arg] = process.argv.slice(2)
try {
  if (cmd === 'prepare') await prepare(arg || '.')
  else if (cmd === 'tidy') await tidy()
  else throw new Error('use: prepare <dir> | tidy')
} catch (e) {
  const m = String(e.message || e)
  const hint = /maximum|limit|already have a current/i.test(m)
    ? ' The account has as many distribution certificates as Apple allows: revoke an old one at developer.apple.com > Certificates.'
    : /forbidden|not allowed|NOT_AUTHORIZED|403/i.test(m) ? ' The API key needs the Admin role (App Store Connect > Users and Access > Integrations).' : ''
  console.error(`::error title=App Store Connect::${m}${hint}`)
  process.exit(1)
}
