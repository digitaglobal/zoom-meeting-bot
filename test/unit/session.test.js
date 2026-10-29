'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const zlib = require('zlib')
const { isZoomCookie, toCookieParams, encodeSession, decodeSession, describeSession } = require('../../src/session')

const cookie = (over = {}) => ({ name: 'sid', value: 'SECRET-VALUE-123', domain: '.zoom.us', path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: 1900000000, session: false, size: 20, priority: 'Medium', ...over })

test('isZoomCookie: zoom.us and its subdomains only', () => {
  for (const d of ['zoom.us', '.zoom.us', 'app.zoom.us', 'us06web.zoom.us']) assert.ok(isZoomCookie({ domain: d }), d)
  for (const d of ['notzoom.us', 'zoom.us.evil.com', 'google.com', '', undefined]) assert.ok(!isZoomCookie({ domain: d }), String(d))
})

test('session: encode then decode gives the same Zoom cookies back', () => {
  const cookies = [cookie(), cookie({ name: 'b', domain: 'app.zoom.us' }), cookie({ name: 'other', domain: 'google.com' })]
  const text = encodeSession(cookies)
  assert.match(text, /^[A-Za-z0-9+/=]+$/, 'one line of plain text, safe to paste')
  const back = decodeSession(text)
  assert.equal(back.length, 2, 'the google.com cookie was left out')
  assert.deepEqual(back.map((c) => c.name), ['sid', 'b'])
  assert.equal(back[0].value, 'SECRET-VALUE-123')
})

test('session: other sites\' cookies are never exported', () => {
  assert.throws(() => encodeSession([cookie({ domain: 'google.com' })]), /No Zoom cookies/)
  const text = zlib.gzipSync(JSON.stringify([cookie({ domain: 'evil.com' })])).toString('base64')
  assert.throws(() => decodeSession(text), /not a valid saved session/)
})

test('session: garbage is refused and the error never echoes what was pasted', () => {
  for (const bad of ['hello world', 'not base64!!', Buffer.from('plain text').toString('base64'), zlib.gzipSync('{"a":1}').toString('base64'), zlib.gzipSync('[{"x":1}]').toString('base64')]) {
    try { decodeSession(bad); assert.fail('should have thrown') } catch (e) {
      assert.match(e.message, /not a valid saved session/)
      assert.ok(!e.message.includes(bad), 'the input is not repeated in the error')
    }
  }
  assert.deepEqual(decodeSession(''), [])
  assert.deepEqual(decodeSession('   '), [])
})

test('session: a huge compressed bomb is refused', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024, 'a')).toString('base64')
  assert.throws(() => decodeSession(bomb), /not a valid saved session/)
})

test('session: too large for a GitHub secret is refused', () => {
  const many = Array.from({ length: 3000 }, (_, i) => cookie({ name: `n${i}`, value: Math.random().toString(36).repeat(8) }))
  assert.throws(() => encodeSession(many), /48 KB/)
})

test('toCookieParams: only the fields Chrome accepts, session cookies keep no expiry', () => {
  const [a, b] = toCookieParams([cookie(), cookie({ name: 's', session: true, expires: -1 })])
  assert.deepEqual(Object.keys(a).sort(), ['domain', 'expires', 'httpOnly', 'name', 'path', 'sameSite', 'secure', 'value'])
  assert.equal(a.expires, 1900000000)
  assert.ok(!('expires' in b), 'a session cookie has no expiry')
  assert.ok(!('size' in a) && !('priority' in a) && !('session' in a))
})

test('describeSession: counts and dates only, never names or values', () => {
  const d = describeSession([cookie({ expires: 1800000000 }), cookie({ expires: 1900000000 }), cookie({ session: true, expires: -1 })])
  assert.equal(d.count, 3)
  assert.equal(d.soonestExpiry.getTime(), 1800000000 * 1000)
  assert.equal(d.latestExpiry.getTime(), 1900000000 * 1000)
  assert.ok(!JSON.stringify(d).includes('SECRET-VALUE'))
})
