// Contacts: what a signature tells (node --test test/)
import test from 'node:test'
import assert from 'node:assert/strict'
import { fieldLike, readSignature } from '../src/main/contacts.ts'

test('a sentence that mentions the name is not a signature (3 Nov 2026)', () => {
  const text = "Hi Alex,\n\nThis is Aelita, and I'm on the Enterprise team at Higgsfield. * a priority queue and dedicated GPU capacity\n\nThanks!"
  const c = readSignature(text, 'Aelita Kalbayeva', 'aelita@higgsfield.ai')
  assert.equal(c.title, undefined)
  assert.equal(c.company, 'Higgsfield')
})

test('a real signature still fills the card', () => {
  const text = 'Τα λέμε αύριο.\n\nMaria Papadopoulou | Line Producer\nStudio North\nT: +30 210 1234567\nwww.studio-north.gr'
  const c = readSignature(text, 'Maria Papadopoulou', 'maria@studio-north.gr')
  assert.equal(c.title, 'Line Producer')
  assert.equal(c.company, 'Studio North')
  assert.ok(c.phone?.includes('210'))
})

test('fieldLike keeps labels, drops pieces of sentences', () => {
  assert.ok(fieldLike('Producer & Film Director'))
  assert.ok(fieldLike('Υπεύθυνη Παραγωγής'))
  assert.ok(!fieldLike("and I'm on the Enterprise team at Higgsfield."))
  assert.ok(!fieldLike('* a priority queue and dedicated GPU capacity'))
})
