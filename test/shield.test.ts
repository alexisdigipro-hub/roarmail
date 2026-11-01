// The shield: phishing and dangerous mail caught in the reader (node --test test/)
import test from 'node:test'
import assert from 'node:assert/strict'
import { claimedBrand, distance, lookalikeOf, mismatchedLinks, riskyFiles, shield, urgent, type ShieldInput } from '../src/main/shield.ts'

const mail = (o: Partial<ShieldInput> = {}): ShieldInput => ({
  authResults: 'mx.google.com; spf=pass smtp.mailfrom=studio-north.gr; dkim=pass; dmarc=pass', fromName: 'Μαρία Παπαδοπούλου',
  fromEmail: 'maria@studio-north.gr', subject: 'Γύρισμα Παρασκευής', text: 'Τα λέμε την Παρασκευή.', files: [], firstTime: false, known: true, list: false, ...o,
})

test('an ordinary mail from someone you know is ok', () => {
  const s = shield(mail())
  assert.equal(s.level, 'ok'); assert.deepEqual(s.warnings, [])
})

test('the three old warnings still work', () => {
  assert.deepEqual(shield(mail({ authResults: 'x; spf=fail; dkim=fail; dmarc=fail' })).warnings, ['auth'])
  assert.ok(shield(mail({ fromName: 'paypal@paypal.com' })).warnings.includes('nameSpoof'))
  const r = shield(mail({ replyTo: 'someone@else.example' }))
  assert.deepEqual(r.warnings, ['replyTo']); assert.equal(r.level, 'notice'); assert.equal(r.replyTo, 'someone@else.example')
})

test('a brand in the name from another address is danger; from the brand itself it is not', () => {
  const s = shield(mail({ fromName: 'PayPal Service', fromEmail: 'service@pay-help.net', known: false }))
  assert.ok(s.warnings.includes('brand')); assert.equal(s.brand, 'PayPal'); assert.equal(s.level, 'danger')
  assert.equal(claimedBrand('PayPal', '', 'mail.paypal.gr', false), null)
  assert.equal(claimedBrand('Eurobank', '', 'eurobank.gr', false), null)
  assert.equal(claimedBrand('Amazon.de', '', 'amazon.co.uk', false), null)
  assert.equal(claimedBrand('ΕΛΤΑ Courier', '', 'elta-courier.gr', false), null)
  assert.equal(claimedBrand('Τράπεζα Πειραιώς', '', 'secure-bank.example', false), 'Piraeus Bank')
  assert.equal(claimedBrand('myAADE', '', 'aade.gr', false), null)
  assert.equal(claimedBrand('gov.gr', '', 'notifications.gov.gr', false), null)
  assert.equal(claimedBrand('gov.gr wallet', '', 'gov-gr.info', false), 'gov.gr')
  // ambiguous words only in the name, never in a subject
  assert.equal(claimedBrand('Nikos', 'ups and downs', 'x.gr', true), null)
  assert.equal(claimedBrand('Big Apple Studio', '', 'bigapple.gr', false), null)
  assert.equal(claimedBrand('Nova Films', '', 'novafilms.gr', false), null)
  assert.equal(claimedBrand('Apple Support', '', 'secure-id.example', false), 'Apple')
  assert.equal(claimedBrand('NOVA', '', 'promo-tv.example', false), 'Nova')
  // someone you write to may say Google
  assert.ok(!shield(mail({ fromName: 'Maria, Google', known: true })).warnings.includes('brand'))
})

test('a brand in the subject counts only from a first-time sender who pushes', () => {
  assert.ok(!shield(mail({ subject: 'WeTransfer με τα rushes', known: false, firstTime: true })).warnings.includes('brand'))
  assert.ok(shield(mail({ subject: 'PayPal: confirm your account', known: false, firstTime: true })).warnings.includes('brand'))
  assert.ok(!shield(mail({ subject: 'PayPal: confirm your account', known: false, firstTime: false })).warnings.includes('brand'))
})

test('addresses made to look like a brand', () => {
  assert.equal(lookalikeOf('paypa1.com'), 'PayPal')
  assert.equal(lookalikeOf('arnazon.com'), 'Amazon')
  assert.equal(lookalikeOf('g00gle.com'), 'Google')
  assert.equal(lookalikeOf('paypal-secure.net'), 'PayPal')
  assert.equal(lookalikeOf('micros0ft-support.com'), 'Microsoft')
  assert.equal(lookalikeOf('rnicrosoft.com'), 'Microsoft')
  assert.equal(lookalikeOf('linkedln.com'), 'LinkedIn')
  assert.equal(lookalikeOf('eurobamk.gr'), 'Eurobank')
  for (const ok of ['paypal.com', 'gmail.com', 'studio-north.gr', 'offices.gr', 'pcloud.com', 'apply.com', 'mail.com', 'themadlions.com', 'cosmos.gr', 'novafilms.gr'])
    assert.equal(lookalikeOf(ok), null, ok)
  assert.ok(shield(mail({ fromEmail: 'security@xn--pypal-4ve.com' })).warnings.includes('lookalike'))
  assert.equal(shield(mail({ fromEmail: 'security@paypa1.com' })).level, 'danger')
  assert.equal(distance('paypal', 'paypa1'), 1)
})

test('attachments that can run something or hide what they are', () => {
  assert.deepEqual(riskyFiles(['invoice.pdf', 'photo.jpg', 'script.fdx', 'call.ics'], ''), [])
  assert.deepEqual(riskyFiles(['invoice.pdf.exe', 'Scan.html', 'setup.MSI', 'a.docm', 'x.iso'], ''), ['invoice.pdf.exe', 'Scan.html', 'setup.MSI', 'a.docm', 'x.iso'])
  assert.deepEqual(riskyFiles(['files.zip'], 'the rushes'), [])
  assert.deepEqual(riskyFiles(['files.zip'], 'Ο κωδικός είναι 1234'), ['files.zip'])
  assert.deepEqual(riskyFiles(['report.pdf.'], ''), [])
  assert.deepEqual(riskyFiles(['invoice‮fdp.exe'], ''), ['invoice‮fdp.exe'])
  assert.equal(shield(mail({ files: ['invoice.pdf.exe'] })).level, 'danger')
})

test('links that show one site and open another', () => {
  assert.equal(mismatchedLinks('<a href="https://paypa1-alerts.net/verify">www.paypal.com/verify</a>'), 1)
  assert.equal(mismatchedLinks('<a href="https://www.paypal.com/x">paypal.com</a><a href="https://evil.example">Click here</a>'), 0)
  assert.equal(mismatchedLinks(`<a class="b" href='https://news.example.com/a'><b>example.com</b></a>`), 0)
  const s = shield(mail({ html: '<a href="https://evil.example/">https://eurobank.gr</a>' }))
  assert.deepEqual(s.warnings, ['links']); assert.equal(s.links, 1); assert.equal(s.level, 'notice')
})

test('a first mail that pushes is a notice; with another warning, danger; a newsletter pair is not', () => {
  assert.ok(urgent('Ο λογαριασμός σας κλειδώθηκε', ''))
  assert.ok(urgent('Hello', 'Please verify your details'))
  assert.ok(urgent('Επείγον: πληρωμή απέτυχε', ''))
  assert.ok(!urgent('Γύρισμα Παρασκευής', 'Τα λέμε'))
  assert.equal(shield(mail({ subject: 'Urgent: payment failed', firstTime: true, known: false })).level, 'notice')
  assert.equal(shield(mail({ subject: 'Urgent: payment failed', firstTime: false })).level, 'ok')
  assert.equal(shield(mail({ subject: 'Urgent', firstTime: true, known: false, replyTo: 'x@other.example' })).level, 'danger')
  const news = shield(mail({ list: true, replyTo: 'x@other.example', html: '<a href="https://click.mailer.example/a">filmgear.com</a>' }))
  assert.equal(news.level, 'notice')
})
