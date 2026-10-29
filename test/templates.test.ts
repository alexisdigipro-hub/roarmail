// Templates: placeholders (node --test test/)
import test from 'node:test'
import assert from 'node:assert/strict'
import { fillTemplate, recipientName } from '../src/renderer/templates.ts'

test('recipientName: the name, else the address before @', () => {
  assert.equal(recipientName('Μαρία Παπαδοπούλου <maria@studio-north.gr>, nikos@x.gr'), 'Μαρία Παπαδοπούλου')
  assert.equal(recipientName('"Doe, John" <john@x.com>'), 'Doe, John')
  assert.equal(recipientName('nikos.kostas@lighthouse.gr'), 'Nikos Kostas')
  assert.equal(recipientName(''), '')
})

test('fillTemplate fills name, first, project and date, in any case', () => {
  const v = { name: 'Μαρία Παπαδοπούλου', project: 'Dream of Elysium', date: '29 Oct 2026' }
  assert.equal(fillTemplate('Hi {first}, about {project} ({date}). {NAME}', v), 'Hi Μαρία, about Dream of Elysium (29 Oct 2026). Μαρία Παπαδοπούλου')
})

test('fillTemplate leaves a placeholder with nothing to put there, and escapes in HTML', () => {
  assert.equal(fillTemplate('Hi {first}, {project}', { name: '', project: '', date: 'x' }), 'Hi {first}, {project}')
  assert.equal(fillTemplate('<p>{project}</p>', { name: '', project: 'A <b> & "c"', date: '' }, true), '<p>A &lt;b&gt; &amp; &quot;c&quot;</p>')
  assert.equal(fillTemplate('{other} {date}', { name: '', project: '', date: 'today' }), '{other} today')
})
