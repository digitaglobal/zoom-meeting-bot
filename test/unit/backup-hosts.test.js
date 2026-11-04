'use strict'
// Backup hosts: people who get host if they are seen before the first choice. The first choice always wins a tie.
const test = require('node:test')
const assert = require('node:assert/strict')
const { runHandover } = require('../../src/handover')
const { loadConfig } = require('../../src/config')
const { chromeEnv } = require('../../src/browserDriver')

const me = (isHost) => ({ userId: 'Bot#1', userName: 'Bot', isMe: true, isHost, waiting: false })
const person = (userName, extra = {}) => ({ userId: `${userName}#1`, userName, isMe: false, isHost: false, waiting: false, ...extra })
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms } } }

// A pretend meeting: `panel(calls)` says who is there; whoever was made host is shown as host a moment later.
function fakeMeeting(panel) {
  const calls = { admit: [], makeHost: [], leave: 0, people: 0 }
  let hostId = null
  const driver = {
    async join() { return { meetingId: '123456789', link: 'https://zoom.us/j/123456789' } },
    async people() {
      calls.people++
      const base = panel(calls)
      if (hostId) return base.map((p) => (p.isMe ? { ...p, isHost: false } : p.userId === hostId ? { ...p, isHost: true } : p))
      return base
    },
    async admit(id) { calls.admit.push(id) },
    async makeHost(id) { calls.makeHost.push(id); hostId = id },
    async leave() { calls.leave++ },
  }
  return { driver, calls }
}

const opts = { newHostName: 'Kemal Example', backupHostNames: ['Jamie Sample', 'Pat Placeholder'], waitMs: 60000, pollMs: 2000, confirmMs: 10000, attempts: 2 }

test('a backup is in and the first choice is not: the backup gets host straight away', async () => {
  const { driver, calls } = fakeMeeting(() => [me(true), person('read.ai meeting notes'), person('Jamie Sample')])
  const out = await runHandover(driver, opts, clock())
  assert.equal(out.ok, true)
  assert.equal(out.usedBackup, true)
  assert.deepEqual(calls.makeHost, ['Jamie Sample#1'])
  assert.equal(calls.leave, 1)
})

test('a backup in the waiting room is admitted, then made host; a stranger is not', async () => {
  const { driver, calls } = fakeMeeting((c) => [me(true), person('Stranger', { waiting: true }), person('Pat Placeholder', { waiting: c.admit.length === 0 })])
  const out = await runHandover(driver, opts, clock())
  assert.equal(out.ok, true)
  assert.deepEqual(calls.admit, ['Pat Placeholder#1'])
  assert.deepEqual(calls.makeHost, ['Pat Placeholder#1'])
})

test('the first choice and a backup are both in at the same check: the first choice gets host', async () => {
  const { driver, calls } = fakeMeeting(() => [me(true), person('Jamie Sample'), person('Kemal Example')])
  const out = await runHandover(driver, opts, clock())
  assert.equal(out.ok, true)
  assert.equal(out.usedBackup, false)
  assert.deepEqual(calls.makeHost, ['Kemal Example#1'])
})

test('a backup is already in but the first choice is waiting at the same moment: the first choice is let in and gets host', async () => {
  const { driver, calls } = fakeMeeting((c) => [me(true), person('Jamie Sample'), person('Kemal Example', { waiting: c.admit.length === 0 })])
  const out = await runHandover(driver, opts, clock())
  assert.equal(out.ok, true)
  assert.deepEqual(calls.admit, ['Kemal Example#1'])
  assert.deepEqual(calls.makeHost, ['Kemal Example#1'])
})

test('the list order breaks a tie between two backups; nobody off the list is ever made host', async () => {
  const { driver, calls } = fakeMeeting(() => [me(true), person('Pat Placeholder'), person('Jamie Sample'), person('Someone Else')])
  const out = await runHandover(driver, opts, clock())
  assert.equal(out.ok, true)
  assert.deepEqual(calls.makeHost, ['Jamie Sample#1'], 'Jamie Sample comes before Pat Placeholder on the list')
})

test('a name that fits two people is skipped, not guessed; the next name on the list is still tried', async () => {
  const { driver, calls } = fakeMeeting(() => [me(true), person('Kemal Example'), { ...person('Kemal Example'), userId: 'Kemal Example#2' }, person('Pat Placeholder')])
  const out = await runHandover(driver, opts, clock())
  assert.equal(out.ok, true)
  assert.deepEqual(calls.makeHost, ['Pat Placeholder#1'])
})

test('nobody on the list arrives: nothing is done and the bot does not leave', async () => {
  const { driver, calls } = fakeMeeting(() => [me(true), person('read.ai meeting notes'), person('Jamie Samples')])
  const out = await runHandover(driver, { ...opts, waitMs: 10000 }, clock())
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'new-host-not-found')
  assert.deepEqual(calls.makeHost, [])
  assert.equal(calls.leave, 0)
})

test('with no backups the behaviour is the same as before: only the first choice', async () => {
  const { driver, calls } = fakeMeeting(() => [me(true), person('Jamie Sample')])
  const out = await runHandover(driver, { newHostName: 'Kemal Example', waitMs: 10000 }, clock())
  assert.equal(out.ok, false)
  assert.deepEqual(calls.makeHost, [])
})

test('a public log never shows a name, and says only that a backup was used', async () => {
  const lines = []
  const { driver } = fakeMeeting((c) => [me(true), person('Jamie Sample', { waiting: c.admit.length === 0 })])
  const out = await runHandover(driver, { ...opts, redactNames: true }, { ...clock(), log: (m) => lines.push(m) })
  assert.equal(out.ok, true)
  const text = lines.join('\n')
  assert.ok(!/Jamie|Sample|Kemal|Example|Placeholder/.test(text), 'no display name in a public log')
  assert.match(text, /backup host/i)
})

test('a local log may name the people it is waiting for', async () => {
  const lines = []
  const { driver } = fakeMeeting(() => [me(true), person('Kemal Example')])
  await runHandover(driver, { ...opts, redactNames: false }, { ...clock(), log: (m) => lines.push(m) })
  assert.match(lines.join('\n'), /"Kemal Example" or "Jamie Sample" or "Pat Placeholder"/)
})

// ---------- settings ----------
test('config: BACKUP_HOST_NAMES splits on commas, semicolons and new lines, trims, and drops blanks, repeats and the first choice', () => {
  const c = loadConfig({ ZOOM_USERNAME: 'a@b.com', ZOOM_PASSWORD: 'x', NEW_HOST_NAME: 'Kemal Example', BACKUP_HOST_NAMES: ' Jamie Sample ,Pat Placeholder;\njamie  sample\n\nKemal Example, ' })
  assert.deepEqual(c.backupHostNames, ['Jamie Sample', 'Pat Placeholder'])
  assert.deepEqual(loadConfig({ ZOOM_USERNAME: 'a@b.com', ZOOM_PASSWORD: 'x' }).backupHostNames, [])
})

test('config: on a cloud run a one-word backup name is refused, without printing the name; on your own computer it is allowed', () => {
  const base = { CI: 'true', ZOOM_USERNAME: 'a@b.com', ZOOM_PASSWORD: 'x', NEW_HOST_NAME: 'Kemal Example' }
  assert.throws(() => loadConfig({ ...base, BACKUP_HOST_NAMES: 'Jamie Sample, Jamie' }), (e) => /full display name/.test(e.message) && !/Jamie|Sample/.test(e.message))
  assert.deepEqual(loadConfig({ ...base, BACKUP_HOST_NAMES: 'Jamie Sample' }).backupHostNames, ['Jamie Sample'])
  assert.deepEqual(loadConfig({ ZOOM_USERNAME: 'a@b.com', ZOOM_PASSWORD: 'x', BACKUP_HOST_NAMES: 'Jamie' }).backupHostNames, ['Jamie'])
})

test('config: too many, too long or empty-looking backup names are refused', () => {
  const base = { ZOOM_USERNAME: 'a@b.com', ZOOM_PASSWORD: 'x' }
  assert.throws(() => loadConfig({ ...base, BACKUP_HOST_NAMES: Array.from({ length: 21 }, (_, i) => `Person Number${String.fromCharCode(97 + i)}`).join(',') }), /at most 20/)
  assert.throws(() => loadConfig({ ...base, BACKUP_HOST_NAMES: 'x'.repeat(101) }), /too long/)
  assert.throws(() => loadConfig({ ...base, BACKUP_HOST_NAMES: '!!!' }), /no letters or digits/)
})

test('chrome environment: the backup names are removed, like the first choice', () => {
  assert.deepEqual(Object.keys(chromeEnv({ PATH: '/bin', BACKUP_HOST_NAMES: 'a b', backup_host_names: 'a b', NEW_HOST_NAME: 'x' })), ['PATH'])
})
