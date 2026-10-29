'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { norm, findNewHost, hostTransferred } = require('../../src/participants')

const P = (userName, extra = {}) => ({ userId: `${userName}#1`, userName, isMe: false, isHost: false, waiting: false, ...extra })
const ME = P('Digita Global', { isMe: true, isHost: true })
const READ = P('read.ai meeting notes')

test('norm ignores case, accents, hyphens and brackets', () => {
  assert.equal(norm('  KEMÁL-Test (iPhone) '), 'kemal test iphone')
})

test('an exact name wins', () => {
  assert.equal(findNewHost([ME, READ, P('Kemal')], { name: 'kemal' }).match.userName, 'Kemal')
})

test('the first name matches a full display name', () => {
  assert.equal(findNewHost([ME, P('Kemal Example')], { name: 'Kemal' }).match.userName, 'Kemal Example')
  assert.equal(findNewHost([ME, P('Kemal (iPhone)')], { name: 'Kemal' }).match.userName, 'Kemal (iPhone)')
  assert.equal(findNewHost([ME, P('Kemal-Test')], { name: 'Kemal' }).match.userName, 'Kemal-Test')
})

test('a longer name that merely starts the same does not match', () => {
  assert.equal(findNewHost([ME, P('Kemalettin')], { name: 'Kemal' }).match, null)
})

test('the notetaker and other people never match', () => {
  const r = findNewHost([ME, READ, P('Maria Example')], { name: 'Kemal' })
  assert.equal(r.match, null)
  assert.deepEqual(r.ambiguous, [])
})

test('two people who fit are ambiguous: nothing is chosen', () => {
  const r = findNewHost([ME, P('Kemal Example'), P('Kemal Other')], { name: 'Kemal' })
  assert.equal(r.match, null)
  assert.equal(r.ambiguous.length, 2)
})

test('an exact match gets no priority: a lookalike next to the real person makes it ambiguous', () => {
  const r = findNewHost([ME, P('Kemal Example'), P('Kemal')], { name: 'Kemal' })
  assert.equal(r.match, null)
  assert.equal(r.ambiguous.length, 2)
  const r2 = findNewHost([ME, P('Kemal Example'), P('kemal.')], { name: 'Kemal' })
  assert.equal(r2.match, null, 'a guest who types "kemal." cannot win')
})

test('the full display name narrows it: only that person fits', () => {
  const r = findNewHost([ME, P('Kemal Example'), P('Kemal'), P('Kemal Sample')], { name: 'Kemal Example' })
  assert.equal(r.match.userName, 'Kemal Example')
})

test('the bot itself is never the match', () => {
  const me = P('Kemal Bot', { isMe: true })
  assert.equal(findNewHost([me], { name: 'Kemal' }).match, null)
  assert.equal(findNewHost([P('Kemal')], { name: 'Kemal' }, { excludeUserId: 'Kemal#1' }).match, null)
})

test('an empty name matches nobody', () => {
  assert.equal(findNewHost([P('Kemal')], { name: '  ' }).match, null)
})

test('hostTransferred: only when Zoom shows it', () => {
  const k = P('Kemal')
  assert.equal(hostTransferred({ people: [ME, k], targetUserId: k.userId }), false)
  assert.equal(hostTransferred({ people: [{ ...ME, isHost: false }, k], targetUserId: k.userId }), true)
  assert.equal(hostTransferred({ people: [ME, { ...k, isHost: true }], targetUserId: k.userId }), true)
  assert.equal(hostTransferred({ people: [], targetUserId: k.userId }), false)
  // the bot's row unreadable and the target not shown as host: NOT confirmed
  assert.equal(hostTransferred({ people: [k], targetUserId: k.userId }), false)
})
