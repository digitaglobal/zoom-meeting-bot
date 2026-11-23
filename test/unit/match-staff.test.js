'use strict'
// Offline matcher tests. No network, no Zoom, no extra packages.
//   node --test test/unit/match-staff.test.js
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const srcDir = fs.existsSync(path.join(__dirname, '..', 'participants.js'))
  ? path.join(__dirname, '..')
  : path.join(__dirname, '..', '..', 'src')
const {
  norm, tokens, matchOne, matchKind, findNewHost, hasStaffCollision, pickFromPanel, toStaffEntries, hostTransferred,
} = require(path.join(srcDir, 'participants'))
const { parseStaffData, parseStaffJson, parseStaffOverrides, loadStaffFile, mergeStaff } = require(path.join(srcDir, 'staffList'))
const { runHandover } = require(path.join(srcDir, 'handover'))
const { main: matchCli } = require(path.join(srcDir, 'match-cli'))

const P = (userName, extra = {}) => ({ userId: extra.userId || `${userName}#1`, userName, isMe: false, isHost: false, waiting: false, ...extra })
const ME = P('Meeting host bot', { isMe: true, isHost: true, userId: 'Bot#1' })
const staff = (...rows) => rows.map((r) => (typeof r === 'string' ? { name: r, aliases: [] } : r))

test('norm is case, accent and punctuation insensitive, and drops a trailing period', () => {
  assert.equal(norm('  JORDÁN-Test (iPhone) '), 'jordan test iphone')
  assert.equal(norm('Jordan B.'), 'jordan b')
  assert.equal(norm('jordan b'), 'jordan b')
  assert.deepEqual(tokens('Jordan B.'), ['jordan', 'b'])
})

test('full staff name matches the full Zoom name, with or without a device suffix', () => {
  assert.equal(matchOne('Jordan Banks', 'Jordan Banks'), 'exact')
  assert.equal(matchOne('Jordan Banks', 'jordan  banks'), 'exact')
  assert.equal(matchOne('Jordan Banks', 'Jordan Banks (iPhone)'), 'contains')
  assert.equal(findNewHost([ME, P('Jordan Banks (iPhone)')], { name: 'Jordan Banks' }).match.userName, 'Jordan Banks (iPhone)')
})

test('full staff name matches first name plus last initial, with or without a period', () => {
  for (const shown of ['Jordan B', 'Jordan B.', 'jordan b', 'JORDAN B.']) {
    const r = findNewHost([ME, P(shown)], { name: 'Jordan Banks' })
    assert.equal(r.match && r.match.userName, shown, shown)
    assert.equal(r.kind, 'first-last-initial', shown)
  }
})

test('an alias written as first name plus initial still matches the full Zoom name', () => {
  assert.equal(matchKind('Jordan Banks', 'Jordan Banks', ['Jordan B']), 'exact')
  const r = findNewHost([ME, P('Jordan Banks')], { name: 'Jordan Banks', aliases: ['KB'] })
  assert.equal(r.match.userName, 'Jordan Banks')
})

test('an alias of two or more words can match (a one-word nickname such as KB cannot: see the bare first name tests below)', () => {
  const r = findNewHost([ME, P('J Banks')], { name: 'Jordan Banks', aliases: ['J Banks'] })
  assert.equal(r.match.userName, 'J Banks')
  assert.equal(r.kind, 'exact')
})

test('a longer first name that only starts the same does not match', () => {
  assert.equal(findNewHost([ME, P('Jordanna Banks')], { name: 'Jordan Banks' }).match, null)
  assert.equal(matchOne('Jordan', 'Jordanna'), null)
})

test('a different last name with the same first name does not match a full staff name', () => {
  assert.equal(findNewHost([ME, P('Jordan Bishop')], { name: 'Jordan Banks' }).match, null)
  assert.equal(findNewHost([ME, P('Riley Smith')], { name: 'Riley Mason' }).match, null)
})

test('a guest who shares only the first name does not match a full staff name', () => {
  assert.equal(findNewHost([ME, P('Jordan')], { name: 'Jordan Banks' }).match, null)
  assert.equal(findNewHost([ME, P('Riley')], { name: 'Riley Mason' }).match, null)
})

test('when the search is a first name only, the old whole-word rule still applies', () => {
  assert.equal(findNewHost([ME, P('Jordan Example')], { name: 'Jordan' }).match.userName, 'Jordan Example')
  assert.equal(findNewHost([ME, P('Jordan (iPhone)')], { name: 'Jordan' }).match.userName, 'Jordan (iPhone)')
  assert.equal(findNewHost([ME, P('Jordan-Test')], { name: 'Jordan' }).match.userName, 'Jordan-Test')
  assert.equal(findNewHost([ME, P('Jordan B.')], { name: 'Jordan' }).match.userName, 'Jordan B.')
})

test('a one-word search stays ambiguous if a guest types just the first name next to the real person', () => {
  const r = findNewHost([ME, P('Jordan Example'), P('Jordan')], { name: 'Jordan' })
  assert.equal(r.match, null)
  assert.equal(r.ambiguous.length, 2)
})

test('a full staff name prefers the exact person over a guest who only used the initial form', () => {
  const r = findNewHost([ME, P('Jordan Banks'), P('Jordan B')], { name: 'Jordan Banks' })
  assert.equal(r.match.userName, 'Jordan Banks')
  assert.equal(r.kind, 'exact')
})

test('two people at the same best tier stay ambiguous', () => {
  const r = findNewHost([ME, P('Jordan B'), P('Jordan B.', { userId: 'Jordan B.#1' })], { name: 'Jordan Banks' })
  assert.equal(r.match, null)
  assert.equal(r.ambiguous.length, 2)
})

test('the bot itself is never the match', () => {
  const me = P('Jordan Banks', { isMe: true })
  assert.equal(findNewHost([me], { name: 'Jordan Banks' }).match, null)
  assert.equal(findNewHost([P('Jordan Banks')], { name: 'Jordan Banks' }, { excludeUserId: 'Jordan Banks#1' }).match, null)
})

test('Mary Ann Smith matches Mary S, Mary A Smith, and Mary Ann S', () => {
  const name = 'Mary Ann Smith'
  assert.equal(findNewHost([ME, P('Mary S')], { name }).kind, 'first-last-initial')
  assert.equal(findNewHost([ME, P('Mary A. Smith')], { name }).kind, 'contains')
  assert.equal(findNewHost([ME, P('Mary Ann S')], { name }).kind, 'first-last-initial')
  assert.equal(findNewHost([ME, P('Mary A S')], { name }).kind, 'first-last-initial')
})

test('middle-name leftovers do not invent a match', () => {
  assert.equal(findNewHost([ME, P('Mary Lee Smith')], { name: 'Mary Ann Smith' }).match, null)
})

// ---------- pickFromPanel: priority and collisions ----------

test('when several staff are present, the earlier name on the list wins (Jordan first)', () => {
  const picked = pickFromPanel({
    inside: [ME, P('Riley Mason'), P('Jordan Banks')],
    outside: [],
    entries: staff('Jordan Banks', 'Riley Mason'),
  })
  assert.equal(picked.match.userName, 'Jordan Banks')
  assert.equal(picked.usedBackup, false)
})

test('a lower-priority staff member already inside loses to a first choice who is in the waiting room', () => {
  const picked = pickFromPanel({
    inside: [ME, P('Riley Mason')],
    outside: [P('Jordan B.', { waiting: true })],
    entries: staff('Jordan Banks', 'Riley Mason'),
  })
  assert.equal(picked.match.userName, 'Jordan B.')
  assert.equal(picked.waiting, true)
  assert.equal(picked.usedBackup, false)
  assert.equal(picked.kind, 'first-last-initial')
})

test('if the first choice is absent, the next staff member who is present is chosen', () => {
  const picked = pickFromPanel({
    inside: [ME, P('Riley M')],
    outside: [],
    entries: staff('Jordan Banks', 'Riley Mason'),
  })
  assert.equal(picked.match.userName, 'Riley M')
  assert.equal(picked.usedBackup, true)
  assert.equal(picked.kind, 'first-last-initial')
})

test('Jordan B is not guessed when Jordan Banks and Jordan Bishop are both on the staff list', () => {
  const picked = pickFromPanel({
    inside: [ME, P('Jordan B')],
    outside: [],
    entries: staff('Jordan Banks', 'Jordan Bishop', 'Riley Mason'),
  })
  assert.equal(picked.match, null)
  assert.equal(picked.ambiguous.some((p) => p.userName === 'Jordan B'), true)
  assert.equal(hasStaffCollision(P('Jordan B'), 0, staff('Jordan Banks', 'Jordan Bishop'), 'first-last-initial'), true)
})

test('an exact Jordan Banks still wins even if a guest Jordan B would collide with another staff last initial', () => {
  const picked = pickFromPanel({
    inside: [ME, P('Jordan Banks'), P('Jordan B')],
    outside: [],
    entries: staff('Jordan Banks', 'Jordan Bishop'),
  })
  assert.equal(picked.match.userName, 'Jordan Banks')
  assert.equal(picked.kind, 'exact')
})

test('a guest who is not on the staff list is never chosen', () => {
  const picked = pickFromPanel({
    inside: [ME, P('read.ai meeting notes'), P('Jane Guest')],
    outside: [],
    entries: staff('Jordan Banks', 'Riley Mason'),
  })
  assert.equal(picked.match, null)
  assert.deepEqual(picked.ambiguous, [])
})

// ---------- staff list merge ----------

test('when Slack is down, mergeStaff uses the fail-safe names and override aliases', () => {
  const entries = mergeStaff({
    newHostName: 'Jordan Banks',
    backupHostNames: ['Riley Mason'],
    filePeople: [{ name: 'Jordan Banks', aliases: ['KB'] }],
  })
  assert.deepEqual(entries.map((e) => e.name), ['Jordan Banks', 'Riley Mason'])
  assert.deepEqual(entries[0].aliases, ['KB'])
})

test('when the live roster is present it is the source of truth, and file people not on the roster are not added', () => {
  const entries = mergeStaff({
    newHostName: 'Jordan Banks',
    backupHostNames: ['Riley Mason'],
    filePeople: [{ name: 'Former Employee', aliases: [] }],
    rosterMembers: [
      { slackId: 'U0EXAMPL04', name: 'Jules Rowan', aliases: [] },
      { slackId: 'U0EXAMPL01', name: 'Jordan Banks', aliases: ['Jordan'] },
      { slackId: 'U0EXAMPL07', name: 'Riley Mason', aliases: [] },
    ],
    firstHostSlackId: 'U0EXAMPL01',
  })
  assert.deepEqual(entries.map((e) => e.name), ['Jordan Banks', 'Jules Rowan', 'Riley Mason'])
  assert.ok(!entries.some((e) => e.name === 'Former Employee'))
})

test('parseStaffOverrides reads priority, exclusions and aliases; parseStaffData still returns people', () => {
  const fromArray = parseStaffData(['Jordan Banks', 'Riley Mason'])
  assert.deepEqual(fromArray.map((e) => e.name), ['Jordan Banks', 'Riley Mason'])
  const ov = parseStaffOverrides({
    firstHostSlackId: 'U0EXAMPL01',
    priority: ['U0EXAMPL07'],
    excludeIds: ['U0EXAMPL90', 'U0EXAMPL91'],
    aliases: { U0EXAMPL01: ['KB'] },
  })
  assert.equal(ov.firstHostSlackId, 'U0EXAMPL01')
  assert.deepEqual(ov.priority, ['U0EXAMPL07'])
  assert.equal(ov.excludeIds.length, 2)
  assert.deepEqual(ov.aliases.U0EXAMPL01, ['KB'])
})

test('loadStaffFile reads a JSON override file and rejects a missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zoom-staff-'))
  const file = path.join(dir, 'staff.json')
  fs.writeFileSync(file, JSON.stringify({ aliases: { 'Jordan Banks': ['Jordan B'] } }))
  const rows = loadStaffFile(file)
  assert.deepEqual(rows.aliases['Jordan Banks'], ['Jordan B'])
  assert.throws(() => loadStaffFile(path.join(dir, 'missing.json')), /does not exist/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('parseStaffJson rejects invalid JSON without echoing the text', () => {
  assert.throws(() => parseStaffJson('{not json'), (e) => e.message === 'STAFF_JSON is not valid JSON' && !/not json/.test(e.message))
})

// ---------- dry handover (no clicks) ----------

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

test('a live-style hand-over still makes Jordan B the host when the staff name is Jordan Banks', async () => {
  const { driver, calls } = fakeMeeting(() => [ME, P('read.ai meeting notes'), P('Jordan B.')])
  const out = await runHandover(driver, { newHostName: 'Jordan Banks', waitMs: 60000, pollMs: 2000, confirmMs: 10000, attempts: 2 }, clock())
  assert.equal(out.ok, true)
  assert.equal(out.dryRun, undefined)
  assert.deepEqual(calls.makeHost, ['Jordan B.#1'])
  assert.equal(calls.leave, 1)
})

test('dry handover logs the match and never clicks Admit, Make Host, or Leave', async () => {
  const lines = []
  const { driver, calls } = fakeMeeting((c) => [ME, P('Jordan B.', { waiting: c.people < 99 })])
  const out = await runHandover(driver, {
    newHostName: 'Jordan Banks',
    backupHostNames: ['Riley Mason'],
    waitMs: 60000,
    pollMs: 2000,
    confirmMs: 10000,
    attempts: 2,
    dryHandover: true,
    redactNames: false,
  }, { ...clock(), log: (m) => lines.push(m) })
  assert.equal(out.ok, true)
  assert.equal(out.dryRun, true)
  assert.equal(out.wouldMakeHost, true)
  assert.equal(out.kind, 'first-last-initial')
  assert.equal(out.target.userName, 'Jordan B.')
  assert.deepEqual(calls.admit, [])
  assert.deepEqual(calls.makeHost, [])
  assert.equal(calls.leave, 0)
  assert.match(lines.join('\n'), /Dry run: would/)
  assert.match(lines.join('\n'), /Jordan B/)
  assert.match(lines.join('\n'), /Not clicking/)
})

test('dry handover with redactNames does not print the display name', async () => {
  const lines = []
  const { driver } = fakeMeeting(() => [ME, P('Jordan Banks')])
  const out = await runHandover(driver, { newHostName: 'Jordan Banks', waitMs: 60000, dryHandover: true, redactNames: true }, { ...clock(), log: (m) => lines.push(m) })
  assert.equal(out.ok, true)
  assert.ok(!/Jordan|Banks/.test(lines.join('\n')))
  assert.match(lines.join('\n'), /the new host/)
})

test('hostTransferred is unchanged: only when Zoom shows the change', () => {
  const k = P('Jordan B.')
  assert.equal(hostTransferred({ people: [ME, k], targetUserId: k.userId }), false)
  assert.equal(hostTransferred({ people: [{ ...ME, isHost: false }, k], targetUserId: k.userId }), true)
  assert.equal(hostTransferred({ people: [ME, { ...k, isHost: true }], targetUserId: k.userId }), true)
})

// ---------- offline CLI ----------

test('match-cli: Jordan B is identified as Jordan Banks, and a guest is not', () => {
  const logs = []
  const orig = console.log
  console.log = (m) => logs.push(m)
  try {
    const code = matchCli(['--first', 'Jordan Banks', '--backups', 'Riley Mason', '--people', 'Jordan B., Jane Guest'])
    assert.equal(code, 0)
    assert.match(logs.join('\n'), /Jordan B/)
    assert.match(logs.join('\n'), /first-last-initial/)
    logs.length = 0
    const miss = matchCli(['--first', 'Jordan Banks', '--people', 'Jane Guest'])
    assert.equal(miss, 2)
    assert.match(logs.join('\n'), /no staff member matched/)
  } finally {
    console.log = orig
  }
})

test('match-cli: a roster fixture is used offline, and a guest Jordan Smith is not chosen', () => {
  const logs = []
  const orig = console.log
  console.log = (m) => logs.push(m)
  const fixture = path.join(__dirname, 'fixtures', 'sample-roster.json')
  try {
    const code = matchCli(['--roster', fixture, '--exclude-ids', 'U0EXAMPL90,U0EXAMPL91', '--first-id', 'U0EXAMPL01', '--people', 'Jordan B., Jane Guest'])
    assert.equal(code, 0)
    assert.match(logs.join('\n'), /Jordan B/)
    assert.match(logs.join('\n'), /Jordan Banks/)
    logs.length = 0
    const guest = matchCli(['--roster', fixture, '--exclude-ids', 'U0EXAMPL90,U0EXAMPL91', '--first-id', 'U0EXAMPL01', '--people', 'Jordan Smith'])
    assert.equal(guest, 2)
    assert.match(logs.join('\n'), /no staff member matched/)
  } finally {
    console.log = orig
  }
})

test('toStaffEntries ignores blanks', () => {
  assert.deepEqual(toStaffEntries(['Jordan Banks', '  ', null, 'Riley Mason']).map((e) => e.name), ['Jordan Banks', 'Riley Mason'])
})

// ---------- a bare first name never matches ----------

test('a bare first name never matches a multi-word staff name, even when nobody else has that first name', () => {
  for (const shown of ['Jordan', 'jordan', 'JORDAN', 'Jordan (iPhone)', 'Jordán', 'Jordan  ']) {
    assert.equal(findNewHost([ME, P(shown)], { name: 'Jordan Banks' }).match, null, shown)
    assert.equal(matchKind('Jordan Banks', shown), null, shown)
  }
})

test('a one-word alias never lets a bare first name or a nickname match a multi-word staff name', () => {
  for (const alias of ['Jordan', 'KB', 'JB']) {
    assert.equal(findNewHost([ME, P(alias)], { name: 'Jordan Banks', aliases: [alias] }).match, null, alias)
    assert.equal(matchKind('Jordan Banks', alias, [alias]), null, alias)
  }
})

test('first name plus last initial is the minimum that matches a multi-word staff name', () => {
  for (const shown of ['Jordan B', 'Jordan B.', 'jordan b', 'JORDAN B.']) {
    assert.equal(findNewHost([ME, P(shown)], { name: 'Jordan Banks' }).kind, 'first-last-initial', shown)
  }
})

test('in the panel walk, a bare first name inside or in the waiting room is ignored for every staff entry', () => {
  const entries = staff('Jordan Banks', 'Avery Stone', { name: 'Dana Gray', aliases: ['Dana'] })
  for (const shown of ['Jordan', 'Avery', 'Dana', 'Dana (iPhone)']) {
    const inside = pickFromPanel({ inside: [ME, P(shown)], outside: [], entries })
    assert.equal(inside.match, null, shown)
    assert.deepEqual(inside.ambiguous, [], shown)
    const waiting = pickFromPanel({ inside: [ME], outside: [P(shown)], entries })
    assert.equal(waiting.match, null, shown)
  }
})

test('a one-word alias set in the staff rules is ignored for a person on the Slack list; a two-word one works', () => {
  const overrides = parseStaffOverrides({ aliases: { 'Jordan Banks': ['JB', 'J Banks'] } })
  const entries = mergeStaff({ overrides, rosterMembers: [{ slackId: 'U0EXAMPL01', name: 'Jordan Banks', aliases: [] }] })
  assert.equal(pickFromPanel({ inside: [ME, P('JB')], outside: [], entries }).match, null)
  assert.equal(pickFromPanel({ inside: [ME, P('J Banks')], outside: [], entries }).match.userName, 'J Banks')
})

test('the one exception: a one-word name typed by hand (the old public default) keeps the old whole-word rule', () => {
  assert.equal(findNewHost([ME, P('Jordan Example')], { name: 'Jordan' }).match.userName, 'Jordan Example')
  assert.equal(findNewHost([ME, P('Jordan')], { name: 'Jordan' }).match.userName, 'Jordan')
})

// ---------- an initial form is never a licence to match a longer last name ----------

test('a guest who shares the first name and only the first LETTER of the last name does not match', () => {
  const entry = { name: 'Jordan Banks', aliases: ['Jordan B', 'Jordan B.'] }
  for (const shown of ['Jordan Bishop', 'Jordan Burke', 'Jordan Bell', 'Jordan B Smith', 'Jordan B. Smith', 'Jordan (Galaxy)', 'Jordan Banksy']) {
    assert.equal(findNewHost([ME, P(shown)], entry).match, null, shown)
  }
})

test('first name plus last initial still matches with a device note after it, and the full name with a note too', () => {
  const entry = { name: 'Jordan Banks', aliases: ['Jordan B', 'Jordan B.'] }
  for (const shown of ['Jordan B', 'Jordan B.', 'Jordan B (iPhone)', 'Jordan B. (iPad)', 'Jordan Banks (iPhone)']) {
    assert.ok(findNewHost([ME, P(shown)], entry).match, shown)
  }
})

// ---------- review fixes: M1 (an initial form ranks below the real name), L3 (unknown staff-rule keys are rejected) ----------

const rosterEntries = (names) => mergeStaff({
  rosterMembers: require(path.join(srcDir, 'slackRoster')).attachDerivedAliases(names.map((n, i) => ({ slackId: `U0EXAMPL${10 + i}`, name: n, displayName: '', aliases: [] }))),
})

test('an initial form ranks below the real name, even when it equals the shown name exactly', () => {
  assert.equal(matchOne('Jordan B', 'Jordan B'), 'first-last-initial')
  assert.equal(matchOne('Jordan B', 'Jordan B. (iPhone)'), 'first-last-initial')
  assert.equal(matchOne('Jordan Banks', 'Jordan Banks'), 'exact')
  assert.equal(matchKind('Jordan Banks', 'Jordan B', ['Jordan B']), 'first-last-initial')
})

test('with the Slack list on, a guest "Avery S" never pushes aside the real "Avery Stone" in the waiting room', () => {
  const entries = rosterEntries(['Avery Stone', 'Riley Mason'])
  for (const order of [[P('Avery S'), P('Avery Stone (iPhone)')], [P('Avery Stone (iPhone)'), P('Avery S')]]) {
    const r = pickFromPanel({ inside: [ME], outside: order, entries })
    assert.equal(r.match.userName, 'Avery Stone (iPhone)')
    assert.equal(r.waiting, true)
  }
})

test('with the Slack list on, two staff who share a first name and initial make "Jordan B" ambiguous: nothing is done', () => {
  const entries = rosterEntries(['Jordan Banks', 'Jordan Bishop'])
  const r = pickFromPanel({ inside: [ME, P('Jordan B')], outside: [], entries })
  assert.equal(r.match, null)
  assert.ok(r.ambiguous.length >= 1)
  // each person's full name still works, and a lone "Jordan B" still works when only one Jordan is on staff
  assert.equal(pickFromPanel({ inside: [ME, P('Jordan Bishop')], outside: [], entries }).staff.name, 'Jordan Bishop')
  assert.equal(pickFromPanel({ inside: [ME, P('Jordan B')], outside: [], entries: rosterEntries(['Jordan Banks', 'Riley Mason']) }).staff.name, 'Jordan Banks')
})

test('an unknown key in the staff rules is rejected, never silently ignored (a misspelt exclusion list would leave a shared account eligible)', () => {
  for (const key of ['excludedIds', 'exclude', 'exclusions', 'excludeId', 'ExcludeIds']) {
    assert.throws(() => parseStaffOverrides({ [key]: ['U0EXAMPL90'] }), (e) => /unknown setting/.test(e.message) && !/U0EXAMPL90/.test(e.message), key)
  }
  assert.throws(() => parseStaffJson('{"excludedIds":["U0EXAMPL90"]}'), /unknown setting/)
  assert.throws(() => parseStaffOverrides({ 'U0EXAMPL90 secret!': 1 }), (e) => /unknown setting/.test(e.message) && !/U0EXAMPL90|secret/.test(e.message))
})

test('exclude_ids and excludeIds both work, as a list or as a comma separated string; a bad value is rejected', () => {
  assert.deepEqual(parseStaffOverrides({ exclude_ids: 'U0EXAMPL90, U0EXAMPL91' }).excludeIds, ['U0EXAMPL90', 'U0EXAMPL91'])
  assert.deepEqual(parseStaffOverrides({ exclude_ids: ['U0EXAMPL90'] }).excludeIds, ['U0EXAMPL90'])
  assert.deepEqual(parseStaffOverrides({ excludeIds: ['U0EXAMPL90'] }).excludeIds, ['U0EXAMPL90'])
  assert.deepEqual(parseStaffOverrides({ excludeIds: [] }).excludeIds, [])
  assert.throws(() => parseStaffOverrides({ exclude_ids: 'not-an-id' }), /not a Slack user id/)
})

test('the shipped staff.json.example, and every key the README shows, are accepted', () => {
  const botRoot = path.join(__dirname, '..', '..')
  assert.doesNotThrow(() => parseStaffJson(fs.readFileSync(path.join(botRoot, 'staff.json.example'), 'utf8')))
  assert.doesNotThrow(() => parseStaffOverrides({ firstHostSlackId: 'U0EXAMPL01', priority: ['Avery Stone'], excludeIds: ['U0EXAMPL90'], aliases: { 'Jordan Banks': ['J Banks'] }, people: [{ name: 'Jordan Bishop' }] }))
})

// ---------- M2 (option B): after a name only a device word or a note in brackets may follow ----------

test('extra words around a full name belong to somebody else and do not match', () => {
  for (const [staffName, shown] of [
    ['Jordan Banks', 'Dr Jordan Banks'], ['Jordan Banks', 'Not Jordan Banks'], ['Jordan Banks', 'Jordan Banks Smith'],
    ['Jordan Banks', 'Jordan Banks-Smith'], ['Jordan Banks', 'Jordan Banks - Digita'], ['Maria Lopez', 'Maria Lopez Garcia'],
    ['Maria Lopez', 'Maria Lopez-Garcia'], ['Avery Stone', 'Avery Stone Johnson'], ['Avery Stone', 'Maria Avery Stone'],
  ]) {
    assert.equal(findNewHost([ME, P(shown)], { name: staffName }).match, null, shown)
  }
})

test('after a full name a device word or a note in brackets is fine', () => {
  for (const shown of ['Jordan Banks (iPhone)', 'Jordan Banks (Marketing)', 'Jordan Banks [Digita]', 'Jordan Banks (Marketing) (iPhone)', 'Jordan Banks iPhone', 'Jordan Banks iPad']) {
    const r = findNewHost([ME, P(shown)], { name: 'Jordan Banks' })
    assert.ok(r.match, shown)
    assert.equal(r.kind, 'contains', shown)
  }
})

test('with the Slack list on, a note in brackets works after the full name and the initial form; other extra words do not', () => {
  const entries = rosterEntries(['Avery Stone', 'Riley Mason'])
  for (const shown of ['Avery S (Marketing)', 'Avery S. (iPad)', 'Avery Stone (Ops)', 'Avery Stone [Digita]']) {
    assert.ok(pickFromPanel({ inside: [ME, P(shown)], outside: [], entries }).match, shown)
  }
  for (const shown of ['Dr Avery Stone', 'Avery Stone Johnson', 'Avery S Johnson', 'Avery Stone - Ops', 'Avery S - Ops']) {
    assert.equal(pickFromPanel({ inside: [ME, P(shown)], outside: [], entries }).match, null, shown)
  }
})

test('a hostile display name (very long, thousands of brackets) is handled quickly and does not match', () => {
  const nasty = 'Jordan Banks ' + '('.repeat(5000) + 'x'.repeat(5000)
  const t0 = Date.now()
  assert.equal(findNewHost([ME, P(nasty)], { name: 'Jordan Banks' }).match, null)
  // an over-long name is never cut short (that could hide a trailing word): staff name, lots of padding, then another surname
  assert.equal(findNewHost([ME, P('Jordan Banks' + ' '.repeat(190) + 'Smith')], { name: 'Jordan Banks' }).match, null)
  assert.equal(findNewHost([ME, P('Jordan Banks' + '.'.repeat(190) + 'Smith')], { name: 'Jordan Banks' }).match, null)
  assert.ok(Date.now() - t0 < 1000)
})

test('a middle name left out is still the same person (Mary Smith for Mary Ann Smith), an extra middle name is not', () => {
  assert.equal(findNewHost([ME, P('Mary Smith')], { name: 'Mary Ann Smith' }).match.userName, 'Mary Smith')
  assert.equal(findNewHost([ME, P('Mary Lee Smith')], { name: 'Mary Ann Smith' }).match, null)
})
