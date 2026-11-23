'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')

const srcDir = fs.existsSync(path.join(__dirname, '../src/handover.js'))
  ? path.join(__dirname, '../src')
  : path.join(__dirname, '../../src')

const { runHandover } = require(path.join(srcDir, 'handover.js'))
const { buildReport } = require(path.join(srcDir, 'report.js'))

const me = (isHost) => ({ userId: 'Bot#1', userName: 'Bot', isMe: true, isHost, waiting: false })
const person = (userName, extra = {}) => ({ userId: `${userName}#1`, userName, isMe: false, isHost: false, waiting: false, ...extra })

function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms) => { t += ms } }
}

function fakeMeeting(script, { confirmAfter = 0, makeHostError } = {}) {
  const calls = { join: 0, admit: [], makeHost: [], leave: 0, people: 0 }
  let madeHostAt = null
  const driver = {
    async join() { calls.join++; return { meetingId: '123456789', link: 'https://zoom.us/j/123456789' } },
    async people() {
      calls.people++
      const base = typeof script === 'function' ? script(calls) : script[Math.min(calls.people - 1, script.length - 1)]
      if (madeHostAt !== null && calls.people - madeHostAt >= confirmAfter + 1) {
        return base.map((p) => (p.isMe ? { ...p, isHost: false } : p.userName.startsWith('Jordan') ? { ...p, isHost: true } : p))
      }
      return base
    },
    async admit(id) { calls.admit.push(id) },
    async makeHost(id) {
      calls.makeHost.push(id)
      if (makeHostError && calls.makeHost.length <= (makeHostError.times || 99)) throw new Error(makeHostError.message)
      madeHostAt = calls.people
    },
    async leave() { calls.leave++ },
  }
  return { driver, calls }
}

const opts = { newHostName: 'Jordan', waitMs: 60000, pollMs: 2000, confirmMs: 10000, attempts: 2 }

test('after Admit, the bot re-queries the panel until the person is inside, then uses that row', async () => {
  let insideAfter = 0
  const { driver, calls } = fakeMeeting((c) => {
    if (c.admit.length === 0) return [me(true), person('Jordan B.', { waiting: true })]
    insideAfter++
    // first look after admit still looks like a waiting-room row; then they appear inside
    if (insideAfter < 3) return [me(true)]
    return [me(true), person('Jordan B.')]
  })
  const out = await runHandover(driver, opts, clock())
  assert.equal(out.ok, true)
  assert.deepEqual(calls.admit, ['Jordan B.#1'])
  assert.deepEqual(calls.makeHost, ['Jordan B.#1'])
  assert.ok(insideAfter >= 3, 'must keep polling after admit, not makeHost on the first try')
})

test('if Make Host throws, the reason is host-menu-failed, not new-host-not-found, and the bot does not leave', async () => {
  const { driver, calls } = fakeMeeting(
    [[me(true), person('Jordan B.')]],
    { makeHostError: { message: 'Could not open the menu for that person.', times: 99 } },
  )
  const lines = []
  const out = await runHandover(driver, { ...opts, redactNames: true }, { ...clock(), log: (m) => lines.push(m) })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'host-menu-failed')
  assert.match(out.detail, /the new host joined/i)
  assert.equal(calls.leave, 0)
  assert.equal(calls.makeHost.length, 2, 'the outer hand-over still retries')
  assert.ok(lines.some((l) => /hand-over click failed/.test(l)))
  assert.ok(!lines.some((l) => /has not joined/.test(l)))
  assert.equal(out.target.userName, 'Jordan B.')
})

test('if the first Make Host click fails and the second works, the hand-over still finishes', async () => {
  const { driver, calls } = fakeMeeting(
    [[me(true), person('Jordan')]],
    { makeHostError: { message: 'Could not open the menu for that person.', times: 1 } },
  )
  const out = await runHandover(driver, opts, clock())
  assert.equal(out.ok, true)
  assert.equal(calls.makeHost.length, 2)
  assert.equal(calls.leave, 1)
})

test('report: host-menu-failed says the new host joined but the click failed', () => {
  const r = buildReport({ event: 'handover', ok: false, reason: 'host-menu-failed', detail: 'The new host joined, but the bot could not open their participant menu to make them host. The bot is staying in the meeting as host: please check it now.', meeting: { title: 'X Interview' }, now: new Date('2026-11-19T14:00:49.000Z') })
  assert.equal(r.reason, 'host-menu-failed')
  assert.match(r.text, /the new host joined/)
  assert.match(r.text, /hand-over click failed/)
  assert.match(r.text, /staying in the meeting as host/)
  assert.equal(/has not joined|did not join/.test(r.text), false)
  assert.equal(/export-session/.test(r.text), false)
})

test('report: new-host-not-found still says the hand-over did not finish because they did not join', () => {
  const r = buildReport({ event: 'handover', ok: false, reason: 'new-host-not-found', detail: 'The new host did not arrive.', meeting: { title: 'X Interview' }, now: new Date('2026-11-19T14:00:49.000Z') })
  assert.match(r.text, /did NOT finish/)
  assert.match(r.text, /did not join/)
  assert.match(r.text, /staying in the meeting as host/)
})

test('report: an error event for the menu click is not described as a sign-in problem', () => {
  const r = buildReport({ event: 'error', ok: false, detail: 'Could not open the menu for that person.', now: new Date('2026-11-19T14:00:49.000Z') })
  assert.match(r.text, /the new host joined/)
  assert.match(r.text, /hand-over click failed/)
  assert.equal(/export-session/.test(r.text), false)
})
