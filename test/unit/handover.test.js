'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { runHandover } = require('../../src/handover')

const me = (isHost) => ({ userId: 'Bot#1', userName: 'Bot', isMe: true, isHost, waiting: false })

// A pretend Zoom meeting. `script` says what the panel looks like on each call to people().
function fakeMeeting(script, { confirmAfter = 0 } = {}) {
  const calls = { join: 0, admit: [], makeHost: [], leave: 0, people: 0 }
  let madeHostAt = null
  const driver = {
    async join() { calls.join++; return { meetingId: '123456789', link: 'https://zoom.us/j/123456789' } },
    async people() {
      calls.people++
      const base = typeof script === 'function' ? script(calls) : script[Math.min(calls.people - 1, script.length - 1)]
      // after makeHost + enough polls, Zoom shows the change
      if (madeHostAt !== null && calls.people - madeHostAt >= confirmAfter + 1) {
        return base.map((p) => (p.isMe ? { ...p, isHost: false } : p.userName.startsWith('Kemal') ? { ...p, isHost: true } : p))
      }
      return base
    },
    async admit(id) { calls.admit.push(id) },
    async makeHost(id) { calls.makeHost.push(id); madeHostAt = calls.people },
    async leave() { calls.leave++ },
  }
  return { driver, calls }
}

function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms) => { t += ms } }
}

const person = (userName, extra = {}) => ({ userId: `${userName}#1`, userName, isMe: false, isHost: false, waiting: false, ...extra })
const opts = { newHostName: 'Kemal', waitMs: 60000, pollMs: 2000, confirmMs: 10000, attempts: 2 }

test('Kemal is already in: made host, confirmed, bot leaves once', async () => {
  const { driver, calls } = fakeMeeting([[me(true), person('read.ai meeting notes'), person('Kemal Example')]])
  const out = await runHandover(driver, opts, clock())
  assert.equal(out.ok, true)
  assert.deepEqual(calls.makeHost, ['Kemal Example#1'])
  assert.equal(calls.leave, 1)
  assert.deepEqual(calls.admit, [])
})

test('Kemal arrives late: the bot waits, then hands over', async () => {
  const { driver, calls } = fakeMeeting([
    [me(true), person('read.ai meeting notes')],
    [me(true), person('read.ai meeting notes')],
    [me(true), person('read.ai meeting notes'), person('Kemal')],
  ])
  const out = await runHandover(driver, opts, clock())
  assert.equal(out.ok, true)
  assert.deepEqual(calls.makeHost, ['Kemal#1'])
  assert.equal(calls.leave, 1)
})

test('Kemal in the waiting room: only Kemal is admitted, then made host', async () => {
  const { driver, calls } = fakeMeeting((c) => {
    const kemalWaiting = c.admit.length === 0
    return [me(true), person('Stranger', { waiting: true }), person('Kemal-Test', { waiting: kemalWaiting })]
  })
  const out = await runHandover(driver, opts, clock())
  assert.equal(out.ok, true)
  assert.deepEqual(calls.admit, ['Kemal-Test#1'], 'must not admit the stranger')
  assert.deepEqual(calls.makeHost, ['Kemal-Test#1'])
  assert.equal(calls.leave, 1)
})

test('Kemal never arrives: nothing is done, the bot does not leave', async () => {
  const { driver, calls } = fakeMeeting([[me(true), person('read.ai meeting notes')]])
  const out = await runHandover(driver, { ...opts, waitMs: 10000 }, clock())
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'new-host-not-found')
  assert.equal(calls.makeHost.length, 0)
  assert.equal(calls.leave, 0)
})

test('two Kemals: the bot refuses to guess', async () => {
  const { driver, calls } = fakeMeeting([[me(true), person('Kemal Example'), person('Kemal Other')]])
  const out = await runHandover(driver, { ...opts, waitMs: 10000 }, clock())
  assert.equal(out.ok, false)
  assert.equal(calls.makeHost.length, 0)
  assert.equal(calls.admit.length, 0)
  assert.equal(calls.leave, 0)
})

test('the notetaker is never admitted or made host when Kemal is the target', async () => {
  const { driver, calls } = fakeMeeting([[me(true), person('read.ai meeting notes'), person('Maria', { waiting: true })]])
  const out = await runHandover(driver, { ...opts, waitMs: 6000 }, clock())
  assert.equal(out.ok, false)
  assert.equal(calls.makeHost.length, 0)
  assert.equal(calls.admit.length, 0)
  assert.equal(calls.leave, 0)
})

test('Zoom never shows the change: the bot stays and does not leave', async () => {
  const { driver, calls } = fakeMeeting([[me(true), person('Kemal')]], { confirmAfter: 9999 })
  const out = await runHandover(driver, opts, clock())
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'host-transfer-not-confirmed')
  assert.equal(calls.makeHost.length, 2, 'tries again once')
  assert.equal(calls.leave, 0)
})

test('the change shows up a few checks later: still confirmed', async () => {
  const { driver, calls } = fakeMeeting([[me(true), person('Kemal')]], { confirmAfter: 4 })
  const out = await runHandover(driver, opts, clock())
  assert.equal(out.ok, true)
  assert.equal(calls.makeHost.length, 1)
  assert.equal(calls.leave, 1)
})

test('onStarted is called with the meeting link', async () => {
  const { driver } = fakeMeeting([[me(true), person('Kemal')]])
  let seen
  await runHandover(driver, { ...opts, onStarted: (i) => { seen = i } }, clock())
  assert.equal(seen.meetingId, '123456789')
})

test('capital or small letters do not matter: "kemal" finds "KEMAL EXAMPLE", "Kemal" finds "kemal"', async () => {
  for (const [wanted, shown] of [['kemal', 'KEMAL EXAMPLE'], ['KEMAL', 'kemal'], ['Kemal', 'kEmAl']]) {
    const { driver, calls } = fakeMeeting([[me(true), person(shown, { waiting: true })], [me(true), person(shown)]])
    const out = await runHandover(driver, { ...opts, newHostName: wanted }, clock())
    assert.equal(out.ok, true, `${wanted} vs ${shown}`)
    assert.deepEqual(calls.admit, [`${shown}#1`])
    assert.deepEqual(calls.makeHost, [`${shown}#1`])
  }
})

test('public log: with redactNames the real display name is never logged', async () => {
  const lines = []
  const { driver } = fakeMeeting([[me(true), person('Kemal Example', { waiting: true })], [me(true), person('Kemal Example')]])
  const out = await runHandover(driver, { ...opts, redactNames: true }, { ...clock(), log: (m) => lines.push(m) })
  assert.equal(out.ok, true)
  assert.ok(lines.length >= 3)
  assert.ok(!lines.join('\n').includes('Example'), 'the display name must not appear')
  assert.ok(lines.some((l) => /The new host is in the waiting room/.test(l)), 'a generic label is used instead of any name')
})

test('public log: two people who fit are counted, not named', async () => {
  const lines = []
  const { driver } = fakeMeeting([[me(true), person('Kemal A'), person('Kemal B')]])
  const out = await runHandover(driver, { ...opts, waitMs: 6000, redactNames: true }, { ...clock(), log: (m) => lines.push(m) })
  assert.equal(out.ok, false)
  const warn = lines.find((l) => /More than one person fits/.test(l))
  assert.ok(warn && /2 people/.test(warn) && !/Kemal A|Kemal B/.test(warn))
})

test('local log (not redacted) still names the person, which is useful on your own computer', async () => {
  const lines = []
  const { driver } = fakeMeeting([[me(true), person('Kemal Example')]])
  await runHandover(driver, { ...opts, redactNames: false }, { ...clock(), log: (m) => lines.push(m) })
  assert.ok(lines.join('\n').includes('Kemal Example'))
})
