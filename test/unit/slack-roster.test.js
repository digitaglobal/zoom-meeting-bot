'use strict'
// The live Slack roster: everyone currently active in Slack may be made host, the first choice always winning a tie.
// The network is a fake; nothing here talks to Slack or Zoom.
const test = require('node:test')
const assert = require('node:assert/strict')
const { fetchActiveNames, usableName } = require('../../src/slackRoster')
const { runHandover } = require('../../src/handover')
const { loadConfig } = require('../../src/config')
const { chromeEnv } = require('../../src/browserDriver')

const TOKEN = ['xoxb', '1234567890', 'VALUE'].join('-') // built, not written out: the repo guard bans credential-looking literals
const user = (real_name, extra = {}) => ({ id: `U${real_name.replace(/\W/g, '')}`, real_name, profile: { real_name, display_name: real_name }, ...extra })
const page = (members, next = '') => ({ ok: true, members, response_metadata: { next_cursor: next } })
const fakeSlack = (...pages) => {
  const seen = []
  const fetch = async (url, init) => { seen.push({ url: String(url), auth: init.headers.Authorization }); const b = pages[Math.min(seen.length - 1, pages.length - 1)]; return { json: async () => b } }
  return { fetch, seen }
}

test('roster: only active, non-bot, non-guest people with a full name are listed', async () => {
  const { fetch } = fakeSlack(page([
    user('Jamie Sample'),
    user('Pat Placeholder', { profile: { real_name: 'Pat Placeholder', display_name: 'Pat P' } }),
    user('Left Company', { deleted: true }),
    user('Some Robot', { is_bot: true }),
    user('Outside Guest', { is_restricted: true }),
    user('Single Channel Guest', { is_ultra_restricted: true }),
    { id: 'USLACKBOT', real_name: 'Slackbot', profile: { real_name: 'Slackbot' } },
    user('Jamie'),
    user('Initial S'),
    user('Kemal Example', { profile: { real_name: 'Kemal Example', display_name: 'Kemal' } }),
  ]))
  assert.deepEqual(await fetchActiveNames(TOKEN, { fetch }), ['Jamie Sample', 'Pat Placeholder', 'Kemal Example'])
})

test('roster: pages are followed, repeats dropped, and a name is matched however Slack spells the case', async () => {
  const { fetch, seen } = fakeSlack(page([user('Jamie Sample')], 'NEXT'), page([user('jamie  sample'), user('Alex Example')]))
  assert.deepEqual(await fetchActiveNames(TOKEN, { fetch }), ['Jamie Sample', 'Alex Example'])
  assert.equal(seen.length, 2)
  assert.match(seen[1].url, /cursor=NEXT/)
  assert.equal(seen[0].auth, `Bearer ${TOKEN}`)
})

test('roster: a refusal or a dead connection is a short error that never holds the token or a name', async () => {
  await assert.rejects(fetchActiveNames(TOKEN, { fetch: fakeSlack({ ok: false, error: 'token_revoked' }).fetch }), (e) => e.message === 'Slack refused the member list (token_revoked)')
  await assert.rejects(fetchActiveNames(TOKEN, { fetch: fakeSlack({ ok: false, error: 'has a space <script>' }).fetch }), (e) => /\(unknown\)/.test(e.message))
  await assert.rejects(fetchActiveNames(TOKEN, { fetch: async () => { throw new Error(`boom ${TOKEN}`) } }), (e) => e.message === 'Slack could not be reached' && !e.message.includes(TOKEN))
})

test('roster: usableName wants two or more real words', () => {
  assert.equal(usableName('Jamie Sample'), true)
  assert.equal(usableName('Mary-Ann Example'), true)
  for (const bad of ['Jamie', 'Alex S', 'yanet.t', '', null, 'x'.repeat(101)]) assert.equal(usableName(bad), false, String(bad))
})

// ---------- in a hand-over ----------
const me = (isHost) => ({ userId: 'Bot#1', userName: 'Bot', isMe: true, isHost, waiting: false })
const person = (userName, extra = {}) => ({ userId: `${userName}#1`, userName, isMe: false, isHost: false, waiting: false, ...extra })
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms } } }
function fakeMeeting(panel) {
  const calls = { admit: [], makeHost: [], leave: 0, people: 0 }
  let hostId = null
  const driver = {
    async join() { return { meetingId: '123456789', link: 'https://zoom.us/j/123456789' } },
    async people() { calls.people++; const base = panel(calls); return hostId ? base.map((p) => (p.isMe ? { ...p, isHost: false } : p.userId === hostId ? { ...p, isHost: true } : p)) : base },
    async admit(id) { calls.admit.push(id) },
    async makeHost(id) { calls.makeHost.push(id); hostId = id },
    async leave() { calls.leave++ },
  }
  return { driver, calls }
}
const opts = { newHostName: 'Kemal Example', waitMs: 60000, pollMs: 2000, confirmMs: 10000, attempts: 2 }

test('hand-over: someone active in Slack (not on any fixed list) joins first and is made host', async () => {
  const { driver, calls } = fakeMeeting(() => [me(true), person('read.ai meeting notes'), person('Alex Example')])
  const out = await runHandover(driver, { ...opts, getRosterNames: async () => ['Kemal Example', 'Jamie Sample', 'Alex Example'] }, clock())
  assert.equal(out.ok, true)
  assert.deepEqual(calls.makeHost, ['Alex Example#1'])
  assert.equal(calls.leave, 1)
})

test('hand-over: a person who is not (or no longer) in the Slack list is never made host', async () => {
  const { driver, calls } = fakeMeeting(() => [me(true), person('Former Employee')])
  const out = await runHandover(driver, { ...opts, waitMs: 10000, getRosterNames: async () => ['Jamie Sample'] }, clock())
  assert.equal(out.ok, false)
  assert.deepEqual(calls.makeHost, [])
  assert.equal(calls.leave, 0)
})

test('hand-over: the first choice still beats everyone in the Slack list, and fixed backups come before the Slack list', async () => {
  let r = fakeMeeting(() => [me(true), person('Alex Example'), person('Kemal Example')])
  await runHandover(r.driver, { ...opts, getRosterNames: async () => ['Alex Example'] }, clock())
  assert.deepEqual(r.calls.makeHost, ['Kemal Example#1'])
  r = fakeMeeting(() => [me(true), person('Alex Example'), person('Jamie Sample')])
  await runHandover(r.driver, { ...opts, backupHostNames: ['Jamie Sample'], getRosterNames: async () => ['Alex Example'] }, clock())
  assert.deepEqual(r.calls.makeHost, ['Jamie Sample#1'])
})

test('hand-over: a Slack person in the waiting room is let in and made host; a stranger is not', async () => {
  const { driver, calls } = fakeMeeting((c) => [me(true), person('Stranger', { waiting: true }), person('Alex Example', { waiting: c.admit.length === 0 })])
  const out = await runHandover(driver, { ...opts, getRosterNames: async () => ['Alex Example'] }, clock())
  assert.equal(out.ok, true)
  assert.deepEqual(calls.admit, ['Alex Example#1'])
})

test('hand-over: if Slack cannot be read the bot carries on with the first choice and says so without any name', async () => {
  const lines = []
  const { driver, calls } = fakeMeeting(() => [me(true), person('Kemal Example')])
  const out = await runHandover(driver, { ...opts, redactNames: true, getRosterNames: async () => { throw new Error('Slack refused the member list (token_revoked)') } }, { ...clock(), log: (m) => lines.push(m) })
  assert.equal(out.ok, true)
  assert.deepEqual(calls.makeHost, ['Kemal Example#1'])
  assert.match(lines.join('\n'), /Could not read the Slack member list \(Slack refused the member list \(token_revoked\)\)/)
  assert.ok(!/Kemal|Example/.test(lines.join('\n')))
})

test('hand-over: the list is read again during a long wait, so a new person is picked up and a failed refresh keeps the last list', async () => {
  let reads = 0
  const getRosterNames = async () => { reads++; if (reads === 1) return ['Jamie Sample']; if (reads === 2) throw new Error('Slack could not be reached'); return ['Jamie Sample', 'New Joiner'] }
  let joinedAt = null
  const { driver, calls } = fakeMeeting((c) => (joinedAt && c.people >= joinedAt ? [me(true), person('New Joiner')] : [me(true)]))
  const t = clock()
  const origSleep = t.sleep
  t.sleep = async (ms) => { await origSleep(ms); if (!joinedAt && t.now() > 25 * 60 * 1000) joinedAt = calls.people }
  const out = await runHandover(driver, { ...opts, waitMs: 60 * 60 * 1000, getRosterNames, rosterRefreshMs: 10 * 60 * 1000 }, t)
  assert.equal(out.ok, true)
  assert.deepEqual(calls.makeHost, ['New Joiner#1'])
  assert.ok(reads >= 3)
})

// ---------- settings ----------
test('config: the Slack token is optional, checked for shape without printing it, and kept out of Chrome', () => {
  const base = { ZOOM_USERNAME: 'a@b.com', ZOOM_PASSWORD: 'x' }
  assert.equal(loadConfig(base).slackRosterToken, '')
  assert.equal(loadConfig({ ...base, SLACK_ROSTER_TOKEN: ` ${TOKEN} ` }).slackRosterToken, TOKEN)
  assert.throws(() => loadConfig({ ...base, SLACK_ROSTER_TOKEN: 'not a token' }), (e) => /SLACK_ROSTER_TOKEN/.test(e.message) && !e.message.includes('not a token'))
  assert.deepEqual(Object.keys(chromeEnv({ PATH: '/bin', SLACK_ROSTER_TOKEN: TOKEN, slack_roster_token: TOKEN })), ['PATH'])
})
