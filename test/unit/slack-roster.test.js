'use strict'
// Offline Slack roster tests. The network is a fake; nothing here talks to Slack or Zoom.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const srcDir = fs.existsSync(path.join(__dirname, '..', 'participants.js'))
  ? path.join(__dirname, '..')
  : path.join(__dirname, '..', '..', 'src')
const {
  DEFAULT_EXCLUDED_SLACK_IDS,
  DEFAULT_FIRST_HOST_SLACK_ID,
  isActivePerson,
  isExcludedId,
  usableName,
  pickOfficialName,
  firstInitialForms,
  fetchActiveMembers,
  createRosterFetcher,
  loadRosterFixture,
  parseSlackIds,
} = require(path.join(srcDir, 'slackRoster'))
const { mergeStaff } = require(path.join(srcDir, 'staffList'))
const { pickFromPanel, tokens } = require(path.join(srcDir, 'participants'))
const { loadConfig } = require(path.join(srcDir, 'config'))
const { runHandover } = require(path.join(srcDir, 'handover'))

const TOKEN = ['xoxb', '1234567890', 'VALUE'].join('-')
// Made-up shared/test accounts and the person who is first in line. The real ones live only in settings, never in this repo.
const EXCLUDE_IDS = ['U0EXAMPL90', 'U0EXAMPL91']
const FIRST_ID = 'U0EXAMPL01'
const user = (id, real_name, extra = {}) => ({
  id,
  real_name,
  profile: { real_name, display_name: extra.display_name || real_name, ...(extra.profile || {}) },
  ...extra,
})
const page = (members, next = '') => ({ ok: true, members, response_metadata: { next_cursor: next } })
const fakeSlack = (...pages) => {
  const seen = []
  const fetch = async (url, init) => {
    seen.push({ url: String(url), auth: init.headers.Authorization })
    const b = pages[Math.min(seen.length - 1, pages.length - 1)]
    return { json: async () => b }
  }
  return { fetch, seen }
}

const SAMPLE_ACTIVE = [
  user('U0EXAMPL02', 'Avery Stone', { display_name: 'Avery S' }),
  user('U0EXAMPL03', 'Dana Gray'),
  user('U0EXAMPL04', 'Jules Rowan'),
  user('U0EXAMPL01', 'Jordan Banks', { display_name: 'Jordan' }),
  user('U0EXAMPL05', 'Parker Lane'),
  user('U0EXAMPL06', 'Sasha.t', { display_name: 'Sasha' }),
  user('U0EXAMPL07', 'Riley Mason'),
]

test('usableName needs two or more words (a full name, first plus last initial, or Sasha.t); a bare first name is not usable', () => {
  assert.equal(usableName('Jordan Banks'), true)
  assert.equal(usableName('Avery S'), true)
  assert.equal(usableName('Sasha.t'), true)
  assert.equal(usableName('Jordan'), false)
  assert.equal(usableName('Casey'), false)
  assert.equal(usableName(''), false)
  assert.equal(usableName('x'.repeat(101)), false)
})

test('official name prefers the fuller real name over a short display name, and keeps Sasha.t', () => {
  assert.equal(pickOfficialName(user('U0EXAMPL01', 'Jordan Banks', { display_name: 'Jordan' })), 'Jordan Banks')
  assert.equal(pickOfficialName(user('U0EXAMPL06', 'Sasha.t', { display_name: 'Sasha' })), 'Sasha.t')
  assert.deepEqual(firstInitialForms('Jordan Banks'), ['Jordan B', 'Jordan B.'])
  assert.deepEqual(firstInitialForms('Sasha.t'), ['Sasha T', 'Sasha T.'])
  assert.deepEqual(firstInitialForms('Avery Stone'), ['Avery S', 'Avery S.'])
})

test('roster: deactivated people, bots, guests, and the default excluded ids are skipped', async () => {
  const { fetch } = fakeSlack(page([
    ...SAMPLE_ACTIVE,
    user('U0EXAMPL90', 'Front Desk'),
    user('U0EXAMPL91', 'Casey'),
    user('UDEAD00000', 'Left Company', { deleted: true }),
    user('UBOT000000', 'Some Robot', { is_bot: true }),
    user('UGUEST0000', 'Outside Guest', { is_restricted: true }),
    user('UGUEST0001', 'Single Channel Guest', { is_ultra_restricted: true }),
    { id: 'USLACKBOT', real_name: 'Slackbot', profile: { real_name: 'Slackbot' } },
  ]))
  const members = await fetchActiveMembers(TOKEN, { fetch, excludeIds: EXCLUDE_IDS })
  assert.deepEqual(members.map((m) => m.name), [
    'Avery Stone', 'Dana Gray', 'Jules Rowan', 'Jordan Banks', 'Parker Lane', 'Sasha.t', 'Riley Mason',
  ])
  assert.ok(!members.some((m) => m.name === 'Front Desk' || m.name === 'Casey' || m.name === 'Slackbot'))
  assert.equal(isExcludedId('U0EXAMPL90', EXCLUDE_IDS), true)
  assert.equal(isActivePerson({ id: 'X', deleted: true }), false)
})

test('roster: derived aliases are First L and First L. only, and every alias has two or more words (never a bare first name)', async () => {
  const { fetch } = fakeSlack(page(SAMPLE_ACTIVE))
  const members = await fetchActiveMembers(TOKEN, { fetch })
  const byName = Object.fromEntries(members.map((m) => [m.name, m]))
  assert.ok(byName['Jordan Banks'].aliases.includes('Jordan B') || byName['Jordan Banks'].aliases.includes('Jordan B.'))
  assert.ok(byName['Avery Stone'].aliases.includes('Avery S') || byName['Avery Stone'].aliases.includes('Avery S.'))
  assert.ok(byName['Riley Mason'].aliases.includes('Riley M') || byName['Riley Mason'].aliases.includes('Riley M.'))
  // Slack display names that are only a first name ("Jordan", "Sasha") are NOT kept, even though nobody else shares that first name.
  assert.ok(!byName['Jordan Banks'].aliases.includes('Jordan'))
  assert.ok(!byName['Sasha.t'].aliases.includes('Sasha'))
  for (const m of members) for (const a of m.aliases) assert.ok(tokens(a).length >= 2, 'a one-word alias slipped in')
})

test('roster: a refusal or a dead connection is a short error that never holds the token or a name', async () => {
  await assert.rejects(fetchActiveMembers(TOKEN, { fetch: fakeSlack({ ok: false, error: 'token_revoked' }).fetch }), (e) => e.message === 'Slack refused the member list (token_revoked)')
  await assert.rejects(fetchActiveMembers(TOKEN, { fetch: fakeSlack({ ok: false, error: 'has a space <script>' }).fetch }), (e) => /\(unknown\)/.test(e.message))
  await assert.rejects(fetchActiveMembers(TOKEN, { fetch: async () => { throw new Error(`boom ${TOKEN}`) } }), (e) => e.message === 'Slack could not be reached' && !e.message.includes(TOKEN))
})

test('roster: one successful call is cached for the run; a failed call is not cached', async () => {
  const { fetch, seen } = fakeSlack(page(SAMPLE_ACTIVE))
  const get = createRosterFetcher(TOKEN, { fetch, excludeIds: EXCLUDE_IDS })
  const first = await get()
  const second = await get()
  assert.equal(first, second)
  assert.equal(seen.length, 1)
  get.clear()
  await get()
  assert.equal(seen.length, 2)

  let calls = 0
  const failing = createRosterFetcher(TOKEN, { fetch: async () => { calls++; throw new Error('network') } })
  await assert.rejects(failing())
  await assert.rejects(failing())
  assert.equal(calls, 2)
})

test('parseSlackIds: an empty setting excludes nobody, a list is read as given, and a bad value is never echoed', () => {
  assert.deepEqual(parseSlackIds('', { defaults: DEFAULT_EXCLUDED_SLACK_IDS }), [])
  assert.deepEqual(parseSlackIds(undefined, { defaults: DEFAULT_EXCLUDED_SLACK_IDS }), [])
  assert.deepEqual(parseSlackIds('U0EXAMPL90, U0EXAMPL91'), ['U0EXAMPL90', 'U0EXAMPL91'])
  assert.throws(() => parseSlackIds('not-an-id'), (e) => /not a Slack user id/.test(e.message) && !/not-an-id/.test(e.message))
})

test('offline fixture drops Front Desk and Casey, and mergeStaff puts Jordan first by Slack id', () => {
  const file = path.join(__dirname, 'fixtures', 'sample-roster.json')
  const members = loadRosterFixture(file, { excludeIds: EXCLUDE_IDS })
  assert.deepEqual(members.map((m) => m.name), [
    'Avery Stone', 'Dana Gray', 'Jules Rowan', 'Jordan Banks', 'Parker Lane', 'Sasha.t', 'Riley Mason',
  ])
  const entries = mergeStaff({ rosterMembers: members, firstHostSlackId: FIRST_ID })
  assert.equal(entries[0].name, 'Jordan Banks')
  assert.equal(entries[0].slackId, 'U0EXAMPL01')
  assert.ok(entries.length === 7)
})

const P = (userName, extra = {}) => ({ userId: extra.userId || `${userName}#1`, userName, isMe: false, isHost: false, waiting: false, ...extra })
const ME = P('Meeting host bot', { isMe: true, isHost: true, userId: 'Bot#1' })

function entriesFromFixture() {
  return mergeStaff({
    rosterMembers: loadRosterFixture(path.join(__dirname, 'fixtures', 'sample-roster.json'), { excludeIds: EXCLUDE_IDS }),
    firstHostSlackId: FIRST_ID,
  })
}

test('Sample roster: Zoom variants match the right staff member', () => {
  const entries = entriesFromFixture()
  const cases = [
    ['Jordan B', 'Jordan Banks'],
    ['Jordan B.', 'Jordan Banks'],
    ['Jordan Banks (iPhone)', 'Jordan Banks'],
    ['Avery S', 'Avery Stone'],
    ['Sasha T.', 'Sasha.t'],
    ['Riley M', 'Riley Mason'],
    ['Dana Gray', 'Dana Gray'],
    ['Jules Rowan', 'Jules Rowan'],
    ['Parker Lane', 'Parker Lane'],
  ]
  for (const [shown, staff] of cases) {
    const picked = pickFromPanel({ inside: [ME, P(shown)], outside: [], entries })
    assert.equal(picked.match && picked.staff.name, staff, shown)
  }
})

test('Sample roster: a guest named Jordan Smith does not match Jordan Banks', () => {
  const entries = entriesFromFixture()
  const picked = pickFromPanel({ inside: [ME, P('Jordan Smith')], outside: [], entries })
  assert.equal(picked.match, null)
})

test('Sample roster: Jordan wins when another staff member is also in the meeting', () => {
  const entries = entriesFromFixture()
  const picked = pickFromPanel({ inside: [ME, P('Riley Mason'), P('Jordan B.'), P('Avery S')], outside: [], entries })
  assert.equal(picked.staff.name, 'Jordan Banks')
  assert.equal(picked.match.userName, 'Jordan B.')
  assert.equal(picked.usedBackup, false)
})

test('Sample roster: if Jordan is absent, the next staff member present is chosen', () => {
  const entries = entriesFromFixture()
  const picked = pickFromPanel({ inside: [ME, P('Riley M')], outside: [], entries })
  assert.equal(picked.staff.name, 'Riley Mason')
  assert.equal(picked.usedBackup, true)
})

test('Sample roster: Front Desk and Casey are never chosen, even if they appear in Zoom', () => {
  const entries = entriesFromFixture()
  const picked = pickFromPanel({ inside: [ME, P('Front Desk'), P('Casey')], outside: [], entries })
  assert.equal(picked.match, null)
})

const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms } } }
function fakeMeeting(panel) {
  const calls = { admit: [], makeHost: [], leave: 0, join: 0, people: 0 }
  let hostId = null
  const driver = {
    async join() { calls.join++; return { meetingId: '123456789', link: 'https://zoom.us/j/123456789' } },
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

test('hand-over: if Slack fails, the bot falls back to NEW_HOST_NAME and still makes Jordan B the host', async () => {
  const { driver, calls } = fakeMeeting(() => [ME, P('Jordan B.')])
  const out = await runHandover(driver, {
    newHostName: 'Jordan Banks',
    backupHostNames: ['Riley Mason'],
    waitMs: 60000,
    pollMs: 2000,
    confirmMs: 10000,
    attempts: 2,
    getRosterNames: async () => { throw new Error('Slack could not be reached') },
  }, clock())
  assert.equal(out.ok, true)
  assert.deepEqual(calls.makeHost, ['Jordan B.#1'])
})

test('hand-over: a successful roster puts Jordan first even if Slack returned him last', async () => {
  const roster = loadRosterFixture(path.join(__dirname, 'fixtures', 'sample-roster.json'))
  // fixture still contains Front Desk / Casey; loader drops them. Shuffle by reversing live members.
  const { driver, calls } = fakeMeeting(() => [ME, P('Jules Rowan'), P('Jordan Banks')])
  const out = await runHandover(driver, {
    newHostName: 'Jordan Banks',
    firstHostSlackId: FIRST_ID,
    waitMs: 60000,
    pollMs: 2000,
    confirmMs: 10000,
    attempts: 2,
    getRosterNames: async () => roster.slice().reverse(),
  }, clock())
  assert.equal(out.ok, true)
  assert.deepEqual(calls.makeHost, ['Jordan Banks#1'])
})

test('shipped defaults name nobody: no id is built into the code, so the settings decide who is skipped and who is first', () => {
  assert.equal(DEFAULT_EXCLUDED_SLACK_IDS.length, 0)
  assert.equal(DEFAULT_FIRST_HOST_SLACK_ID, '')
  const base = { ZOOM_USERNAME: 'a@b.com', ZOOM_PASSWORD: 'x' }
  const none = loadConfig(base)
  assert.deepEqual(none.slackRosterExcludeIds, [])
  assert.equal(none.firstHostSlackId, '')
  const set = loadConfig({ ...base, SLACK_ROSTER_EXCLUDE_IDS: 'U0EXAMPL90, U0EXAMPL91', FIRST_HOST_SLACK_ID: 'U0EXAMPL01' })
  assert.deepEqual(set.slackRosterExcludeIds, ['U0EXAMPL90', 'U0EXAMPL91'])
  assert.equal(set.firstHostSlackId, 'U0EXAMPL01')
})

test('with no FIRST_HOST_SLACK_ID the person named in NEW_HOST_NAME is still first, matched by name', () => {
  const members = loadRosterFixture(path.join(__dirname, 'fixtures', 'sample-roster.json'), { excludeIds: EXCLUDE_IDS }).slice().reverse()
  const entries = mergeStaff({ newHostName: 'Jordan Banks', rosterMembers: members })
  assert.equal(entries[0].name, 'Jordan Banks')
  assert.equal(entries.length, 7)
})

test('with no exclusion setting nobody is skipped, so the settings MUST list shared and test accounts', async () => {
  const { fetch } = fakeSlack(page([...SAMPLE_ACTIVE, user('U0EXAMPL90', 'Front Desk'), user('U0EXAMPL91', 'Test Login')]))
  const names = (await fetchActiveMembers(TOKEN, { fetch })).map((m) => m.name)
  assert.ok(names.includes('Front Desk') && names.includes('Test Login'))
})

// ---------- a bare first name never matches (Slack list on) ----------

test('roster: a member whose Slack name is a single word is left off the list (nobody can be matched by a bare first name)', async () => {
  const { fetch } = fakeSlack(page([...SAMPLE_ACTIVE, user('U0EXAMPL92', 'Casey'), user('U0EXAMPL93', 'Cher', { display_name: 'Cher' })]))
  const names = (await fetchActiveMembers(TOKEN, { fetch })).map((m) => m.name)
  assert.ok(!names.includes('Casey') && !names.includes('Cher'))
  assert.equal(names.length, 7)
})

test('roster: a one-word real name with a two-word display name is kept under the display name', async () => {
  const { fetch } = fakeSlack(page([user('U0EXAMPL94', 'Casey', { display_name: 'Casey R' })]))
  const members = await fetchActiveMembers(TOKEN, { fetch })
  assert.deepEqual(members.map((m) => m.name), ['Casey R'])
})

test('roster: a Slack display name of two or more words is kept as an alias; a one-word display name is not', async () => {
  const { fetch } = fakeSlack(page([
    user('U0EXAMPL95', 'Riley Mason', { display_name: 'Rye Mason' }),
    user('U0EXAMPL96', 'Parker Lane', { display_name: 'Parker' }),
  ]))
  const members = await fetchActiveMembers(TOKEN, { fetch })
  const byName = Object.fromEntries(members.map((m) => [m.name, m]))
  assert.ok(byName['Riley Mason'].aliases.includes('Rye Mason'))
  assert.ok(!byName['Parker Lane'].aliases.includes('Parker'))
})

test('offline fixture: a one-word name is left off even with no exclusions, and Front Desk (two words) is not', () => {
  const members = loadRosterFixture(path.join(__dirname, 'fixtures', 'sample-roster.json'))
  const names = members.map((m) => m.name)
  assert.ok(!names.includes('Casey'))
  assert.ok(names.includes('Front Desk'))
})

test('Sample roster: a bare first name never matches anyone, inside or in the waiting room, even when it is unique', () => {
  const entries = entriesFromFixture()
  assert.ok(entries.length >= 7)
  for (const e of entries) {
    const first = tokens(e.name)[0]
    const cap = first.charAt(0).toUpperCase() + first.slice(1)
    for (const shown of [first, cap, first.toUpperCase(), `${cap} (iPhone)`, `${cap} (Galaxy)`]) {
      const inside = pickFromPanel({ inside: [ME, P(shown)], outside: [], entries })
      assert.equal(inside.match, null, shown)
      assert.deepEqual(inside.ambiguous, [], shown)
      const waiting = pickFromPanel({ inside: [ME], outside: [P(shown)], entries })
      assert.equal(waiting.match, null, shown)
    }
  }
})

test('Sample roster: first name plus last initial is the minimum that still works', () => {
  const entries = entriesFromFixture()
  for (const [shown, staff] of [['Jordan B', 'Jordan Banks'], ['jordan b.', 'Jordan Banks'], ['AVERY S', 'Avery Stone'], ['Sasha T', 'Sasha.t'], ['Dana G.', 'Dana Gray']]) {
    const picked = pickFromPanel({ inside: [ME, P(shown)], outside: [], entries })
    assert.equal(picked.match && picked.staff.name, staff, shown)
  }
})

test('mergeStaff: a one-word roster entry is left out; if nobody usable is left it falls back to the fixed names', () => {
  const some = mergeStaff({ newHostName: 'Jordan Banks', rosterMembers: [{ slackId: 'U0EXAMPL92', name: 'Casey', aliases: [] }, { slackId: 'U0EXAMPL02', name: 'Avery Stone', aliases: [] }] })
  assert.deepEqual(some.map((e) => e.name), ['Avery Stone'])
  const none = mergeStaff({ newHostName: 'Jordan Banks', backupHostNames: ['Riley Mason'], rosterMembers: [{ slackId: 'U0EXAMPL92', name: 'Casey', aliases: [] }] })
  assert.deepEqual(none.map((e) => e.name), ['Jordan Banks', 'Riley Mason'])
})

test('hand-over (Slack list on): a guest who joins as just "Jordan" is never let in and never made host', async () => {
  const roster = loadRosterFixture(path.join(__dirname, 'fixtures', 'sample-roster.json'), { excludeIds: EXCLUDE_IDS })
  for (const waiting of [true, false]) {
    const { driver, calls } = fakeMeeting(() => [ME, P('Jordan', { waiting })])
    const out = await runHandover(driver, {
      newHostName: 'Jordan Banks', firstHostSlackId: FIRST_ID, waitMs: 20000, pollMs: 2000, confirmMs: 10000, attempts: 2,
      getRosterNames: async () => roster,
    }, clock())
    assert.equal(out.ok, false, `waiting=${waiting}`)
    assert.equal(out.reason, 'new-host-not-found')
    assert.deepEqual(calls.admit, [])
    assert.deepEqual(calls.makeHost, [])
  }
})

test('Sample roster: a guest who shares the first name and only the first letter of the last name is never matched', () => {
  const entries = entriesFromFixture()
  for (const shown of ['Jordan Bishop', 'Jordan Burke', 'Avery Smith', 'Avery S Smith', 'Dana Green', 'Dana G. Lopez', 'Dana (Galaxy)', 'Parker Lopez', 'Riley Moss']) {
    assert.equal(pickFromPanel({ inside: [ME, P(shown)], outside: [], entries }).match, null, shown)
    assert.equal(pickFromPanel({ inside: [ME], outside: [P(shown)], entries }).match, null, shown)
  }
  // while the real forms still work, including with a device note
  for (const [shown, staff] of [['Dana G.', 'Dana Gray'], ['Dana G. (iPhone)', 'Dana Gray'], ['Dana Gray (iPhone)', 'Dana Gray'], ['Parker L', 'Parker Lane']]) {
    const picked = pickFromPanel({ inside: [ME, P(shown)], outside: [], entries })
    assert.equal(picked.match && picked.staff.name, staff, shown)
  }
})
