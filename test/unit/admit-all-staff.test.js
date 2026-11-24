'use strict'
// ADMIT_ALL_STAFF: while the bot is host, every staff member waiting in the waiting room is let in, not only the one who is made host.
// Made-up names and ids only. Zoom, Slack and the network are all pretend.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const root = path.join(__dirname, '..', '..')
const src = (name) => require(path.join(root, 'src', name))
const { admissibleStaff, describeAdmission } = src('participants')
const { runHandover } = src('handover')
const { runTick } = src('tick')
const { mergeStaff } = src('staffList')
const { loadRosterFixture, fetchActiveMembers, attachDerivedAliases } = src('slackRoster')
const { loadConfig, ALLOWED_KEYS } = src('config')
const { parseUpcoming } = src('upcoming')

const TOKEN = ['xoxb', '1234567890', 'VALUE'].join('-')
const FIXTURE = path.join(__dirname, 'fixtures', 'sample-roster.json')
// The made-up shared/test accounts (Front Desk, Casey) and the person who is first in line (Jordan Banks).
const EXCLUDE = ['U0EXAMPL90', 'U0EXAMPL91']
const FIRST = 'U0EXAMPL01'

const rosterMembers = () => loadRosterFixture(FIXTURE, { excludeIds: EXCLUDE })
const member = (slackId, name) => attachDerivedAliases([{ slackId, name, displayName: '', aliases: [] }])[0]
const staff = (extra = []) => mergeStaff({ newHostName: 'Jordan Banks', rosterMembers: [...rosterMembers(), ...extra], firstHostSlackId: FIRST })

const bot = (isHost = true) => ({ userId: 'Bot#1', userName: 'Bot', isMe: true, isHost, waiting: false })
const who = (userName, { waiting = true, n = 1 } = {}) => ({ userId: `${userName}#${n}`, userName, isMe: false, isHost: false, waiting })
const inside = (userName, n = 1) => who(userName, { waiting: false, n })
const named = (rows) => rows.map((r) => r.person.userName).sort()

// ---------------------------------------------------------------------------------------------------------------------------------
// The matching rules (admissibleStaff): who in the waiting room counts as staff
// ---------------------------------------------------------------------------------------------------------------------------------

test('every staff member in the waiting room is admitted: full name, first name plus last initial, any capitals, a device word or a note in brackets', () => {
  const waiting = ['Avery Stone', 'dana gray', 'JULES R', 'Parker L.', 'Riley Mason (iPhone)', 'Sasha T', 'Jordan Banks (Marketing)', 'Dana G iPad']
  const r = admissibleStaff({ people: [bot(), ...waiting.map((n) => who(n))], entries: staff() })
  assert.deepEqual(named(r.admit), [...waiting].sort())
  assert.deepEqual(r.refused, [])
})

test('guests, shared accounts and other bots stay in the waiting room', () => {
  const guests = ['Maria Lopez', 'Front Desk', 'Casey', 'read.ai meeting notes', 'Zoom User']
  const r = admissibleStaff({ people: [bot(), ...guests.map((n) => who(n))], entries: staff() })
  assert.deepEqual(r.admit, [])
  assert.deepEqual(r.refused, [], 'a guest is simply not staff; it is not an "ambiguous" case')
})

test('a bare first name is refused, even when nobody else shares it, and so is a one-word nickname or Slack display name', () => {
  // "Jordan" is Jordan Banks's own Slack display name and "Sasha" is Sasha.t's: still not enough to be let in.
  const bare = ['Avery', 'avery', 'Dana (iPhone)', 'Jordan', 'Sasha', 'Jules iPad', 'Riley.']
  const r = admissibleStaff({ people: [bot(), ...bare.map((n) => who(n))], entries: staff() })
  assert.deepEqual(r.admit, [])
})

test('extra words before or after the name are refused', () => {
  const extra = ['Dr Avery Stone', 'Avery Stone Johnson', 'Avery Stone - Ops', 'Not Dana Gray', 'Dana G. Lopez', 'Mr Riley Mason (iPhone)']
  const r = admissibleStaff({ people: [bot(), ...extra.map((n) => who(n))], entries: staff() })
  assert.deepEqual(r.admit, [])
})

test('a last name that only STARTS with the same letter is refused: only the full last name or the single initial counts', () => {
  const lookalikes = ['Avery Smith', 'Dana Green', 'Jordan Bishop', 'Parker Long', 'Jules Ross']
  const r = admissibleStaff({ people: [bot(), ...lookalikes.map((n) => who(n))], entries: staff() })
  assert.deepEqual(r.admit, [])
})

test('a name two staff could fit is refused, never guessed (first name + initial, or the very same full name)', () => {
  const entries = staff([member('U0EXAMPL10', 'Jordan Bishop')])
  const r = admissibleStaff({ people: [bot(), who('Jordan B'), who('Jordan B.'), who('Jordan Banks'), who('Jordan Bishop')], entries })
  assert.deepEqual(named(r.admit), ['Jordan Banks', 'Jordan Bishop'], 'the two full names are each unique')
  assert.deepEqual(named(r.refused), ['Jordan B', 'Jordan B.'])
  assert.ok(r.refused.every((x) => x.reason === 'two-staff'))

  // two different people who have exactly the same full name
  const same = mergeStaff({ newHostName: 'Sam Lee', rosterMembers: [member('U0EXAMPL11', 'Sam Lee'), member('U0EXAMPL12', 'Sam Lee')], firstHostSlackId: '' })
  const r2 = admissibleStaff({ people: [bot(), who('Sam Lee')], entries: same })
  assert.deepEqual(r2.admit, [])
  assert.equal(r2.refused.length, 1)
})

test('control: with only ONE staff member behind that first name and initial, "Jordan B" is let in', () => {
  const r = admissibleStaff({ people: [bot(), who('Jordan B')], entries: staff() })
  assert.deepEqual(named(r.admit), ['Jordan B'])
})

test('two people with the same staff name (or one person on two devices) are not let in; once one leaves, the other is', () => {
  const entries = staff()
  const a = who('Avery Stone', { n: 1 })
  const b = who('Avery Stone', { n: 2 })
  let r = admissibleStaff({ people: [bot(), a, b], entries })
  assert.deepEqual(r.admit, [])
  assert.deepEqual(r.refused.map((x) => x.reason), ['same-name-twice', 'same-name-twice'])
  r = admissibleStaff({ people: [bot(), a], entries })
  assert.equal(r.admit.length, 1, 'the twin left: the one who is left is let in on the next check')
  // a twin who is already INSIDE counts as well
  r = admissibleStaff({ people: [bot(), { ...a, waiting: false }, b], entries })
  assert.deepEqual(r.admit, [])
  assert.equal(r.refused.length, 1)
  // a weaker form of the name next to the full name is a different tier, not a twin
  r = admissibleStaff({ people: [bot(), inside('Avery Stone'), who('Avery S')], entries })
  assert.deepEqual(named(r.admit), ['Avery S'])
})

test('only the waiting room is looked at: people already inside are left alone, and the bot never admits itself', () => {
  const botNamedLikeStaff = { ...bot(), userName: 'Avery Stone' }
  const r = admissibleStaff({ people: [botNamedLikeStaff, inside('Dana Gray'), who('Parker Lane')], entries: staff() })
  assert.deepEqual(named(r.admit), ['Parker Lane'])
})

test('a one-word staff name typed by hand never lets people in (that old whole-word rule is only for picking a host)', () => {
  const handTyped = mergeStaff({ newHostName: 'Alex' }) // the fail-safe list, one word
  const r = admissibleStaff({ people: [bot(), who('Alex'), who('Alex Smith'), who('Alex (guest)')], entries: handTyped })
  assert.deepEqual(r.admit, [])
})

test('an excluded account is never admitted: the Slack list leaves it out, and a fixed entry that carries an excluded id is dropped too', async () => {
  // 1. the fixture roster: Front Desk is excluded, so its own full name does not get it in
  assert.deepEqual(admissibleStaff({ people: [bot(), who('Front Desk')], entries: staff() }).admit, [])
  // 2. the live Slack reader (pretend network). Control: WITHOUT the exclusion the same account is let in under its own name.
  const users = [
    { id: 'U0EXAMPL02', real_name: 'Avery Stone', profile: { real_name: 'Avery Stone', display_name: 'Avery S' } },
    { id: 'U0EXAMPL92', real_name: 'Media Crew', profile: { real_name: 'Media Crew', display_name: 'Media Crew' } },
  ]
  const fetch = async () => ({ json: async () => ({ ok: true, members: users, response_metadata: { next_cursor: '' } }) })
  const people = [bot(), who('Media Crew'), who('Avery Stone')]
  const excluded = await fetchActiveMembers(TOKEN, { fetch, excludeIds: ['U0EXAMPL92'] })
  assert.deepEqual(named(admissibleStaff({ people, entries: mergeStaff({ rosterMembers: excluded }) }).admit), ['Avery Stone'])
  const notExcluded = await fetchActiveMembers(TOKEN, { fetch })
  assert.deepEqual(named(admissibleStaff({ people, entries: mergeStaff({ rosterMembers: notExcluded }) }).admit), ['Avery Stone', 'Media Crew'])
  // 3. a fixed entry (Slack unreadable, or a hand-made list) that carries an excluded id, compared without regard to capitals
  const fixed = [{ name: 'Front Desk', aliases: [], slackId: 'U0EXAMPL90' }, { name: 'Dana Gray', aliases: [], slackId: 'U0EXAMPL03' }]
  assert.deepEqual(named(admissibleStaff({ people: [bot(), who('Front Desk'), who('Dana Gray')], entries: fixed, excludeSlackIds: ['u0exampl90'] }).admit), ['Dana Gray'])
  assert.deepEqual(named(admissibleStaff({ people: [bot(), who('Front Desk'), who('Dana Gray')], entries: fixed, excludeSlackIds: [] }).admit), ['Dana Gray', 'Front Desk'], 'control: without the exclusion it would be admitted')
})

test('a very long display name never matches (it is not cut short, which could hide extra words)', () => {
  const long = `Avery Stone ${'x'.repeat(400)}`
  assert.deepEqual(admissibleStaff({ people: [bot(), who(long)], entries: staff() }).admit, [])
})

test('describeAdmission says what would happen, and gives no names when it is redacted', () => {
  const r = admissibleStaff({ people: [bot(), who('Avery Stone'), who('Maria Lopez')], entries: staff() })
  assert.match(describeAdmission(r, { redact: false }), /would let Avery Stone in/)
  assert.ok(!/Avery/.test(describeAdmission(r, { redact: true })))
  assert.match(describeAdmission({ admit: [], refused: [] }), /nobody in the waiting room matched/)
})

// ---------------------------------------------------------------------------------------------------------------------------------
// The hand-over with the setting on and off (pretend meeting)
// ---------------------------------------------------------------------------------------------------------------------------------

function clock() {
  let t = 0
  return { now: () => t, sleep: async (ms) => { t += ms } }
}

// A pretend meeting that remembers who was admitted and made host. `stuck` = ids for whom clicking Admit does nothing (a laggy panel).
function meeting(initial, { failAdmit = [], stuck = [], clk = clock() } = {}) {
  const state = initial.map((p) => ({ ...p }))
  const calls = { admit: [], admitAt: [], makeHost: [], leave: 0 }
  const find = (id) => state.find((p) => p.userId === id)
  const driver = {
    async join() { return { meetingId: '123456789', link: 'https://zoom.us/j/123456789' } },
    async people() { return state.map((p) => ({ ...p })) },
    async admit(id) {
      calls.admit.push(id); calls.admitAt.push(clk.now())
      if (failAdmit.includes(id)) throw new Error('Could not find an Admit button for that person.')
      if (!stuck.includes(id)) find(id).waiting = false
    },
    async makeHost(id) { calls.makeHost.push(id); state.find((p) => p.isMe).isHost = false; find(id).isHost = true },
    async leave() { calls.leave++ },
  }
  return { driver, calls, state, clk }
}

const baseOpts = { newHostName: 'Jordan Banks', firstHostSlackId: FIRST, waitMs: 60000, pollMs: 2000, confirmMs: 10000, attempts: 2, redactNames: false }
const run = async (m, opts = {}) => {
  const lines = []
  const out = await runHandover(m.driver, { ...baseOpts, staffEntries: staff(), excludeIds: EXCLUDE, ...opts }, { now: m.clk.now, sleep: m.clk.sleep, log: (l) => lines.push(l) })
  return { out, lines }
}
const stillWaiting = (m) => m.state.filter((p) => p.waiting).map((p) => p.userName).sort()

test('OFF (the default): only the person who gets host is let in; other staff stay in the waiting room', async () => {
  const m = meeting([bot(), who('Jordan Banks'), who('Avery Stone'), who('Dana Gray')])
  const { out } = await run(m)
  assert.equal(out.ok, true)
  assert.deepEqual(m.calls.admit, ['Jordan Banks#1'])
  assert.deepEqual(m.calls.makeHost, ['Jordan Banks#1'])
  assert.deepEqual(stillWaiting(m), ['Avery Stone', 'Dana Gray'])
})

test('ON: every staff member in the waiting room is let in once, guests stay waiting, and the host rule still picks the first choice', async () => {
  // Avery and Dana are listed first in the panel, but the first choice (Jordan Banks) is the one who gets host.
  const m = meeting([bot(), who('Avery Stone'), who('Dana Gray'), who('Jordan Banks'), who('Maria Lopez'), who('Front Desk'), who('Jordan')])
  const { out } = await run(m, { admitAllStaff: true })
  assert.equal(out.ok, true)
  assert.deepEqual([...m.calls.admit].sort(), ['Avery Stone#1', 'Dana Gray#1', 'Jordan Banks#1'], 'each staff member exactly once, including the host')
  assert.deepEqual(m.calls.makeHost, ['Jordan Banks#1'], 'the hand-over rule is unchanged: first choice first')
  assert.deepEqual(stillWaiting(m), ['Front Desk', 'Jordan', 'Maria Lopez'], 'a guest, an excluded account and a bare first name are never let in')
  assert.equal(m.calls.leave, 1)
  assert.equal(out.otherStaffLetIn, 2, 'Avery and Dana were let in by the setting; Jordan was admitted by the host rule')
})

test('ON: when the first choice is absent, the next staff member in priority gets host and the others are still let in', async () => {
  const m = meeting([bot(), who('Dana Gray'), who('Avery Stone'), who('Parker Lane')])
  const { out } = await run(m, { admitAllStaff: true })
  assert.equal(out.ok, true)
  assert.deepEqual(m.calls.makeHost, ['Avery Stone#1'], 'Avery is ahead of Dana on the list, as before')
  assert.deepEqual([...m.calls.admit].sort(), ['Avery Stone#1', 'Dana Gray#1', 'Parker Lane#1'])
})

test('ON: a first choice who is already inside is made host, and the staff who are waiting are let in just before', async () => {
  const m = meeting([bot(), inside('Jordan Banks'), who('Avery Stone')])
  const { out } = await run(m, { admitAllStaff: true })
  assert.equal(out.ok, true)
  assert.deepEqual(m.calls.admit, ['Avery Stone#1'])
  assert.deepEqual(m.calls.makeHost, ['Jordan Banks#1'])
})

test('ON: a click on another staff member that fails is logged and never stops the hand-over', async () => {
  const m = meeting([bot(), who('Jordan Banks'), who('Dana Gray')], { failAdmit: ['Dana Gray#1'] })
  const { out, lines } = await run(m, { admitAllStaff: true })
  assert.equal(out.ok, true)
  assert.deepEqual(m.calls.makeHost, ['Jordan Banks#1'])
  assert.equal(m.calls.leave, 1)
  assert.ok(lines.some((l) => /Could not let a staff member in/.test(l) && /hand-over carries on/.test(l)))
})

test('ON: another staff member whose Admit click does not take is clicked at most 3 times, at least 15 seconds apart (no click spam)', async () => {
  // Avery is ahead of Dana on the list, so the host rule is the one working on Avery (that old rule is unchanged and is not under test here);
  // Dana is only ever handled by the new setting. Neither click takes, so neither person ever gets in and nobody gets host.
  const m = meeting([bot(), who('Avery Stone'), who('Dana Gray')], { stuck: ['Avery Stone#1', 'Dana Gray#1'] })
  const { out } = await run(m, { admitAllStaff: true, waitMs: 120000 })
  assert.equal(out.ok, false)
  assert.equal(out.reason, 'new-host-not-found')
  const dana = m.calls.admit.map((id, i) => ({ id, at: m.calls.admitAt[i] })).filter((c) => c.id === 'Dana Gray#1')
  assert.equal(dana.length, 3)
  for (let i = 1; i < dana.length; i++) assert.ok(dana[i].at - dana[i - 1].at >= 15000, 'the retries are spaced')
  assert.equal(m.calls.leave, 0, 'the bot never leaves without handing over')
})

test('OFF: the same stuck meeting never clicks anyone but the person the host rule is working on', async () => {
  const m = meeting([bot(), who('Avery Stone'), who('Dana Gray')], { stuck: ['Avery Stone#1', 'Dana Gray#1'] })
  await run(m, { waitMs: 120000 })
  assert.ok(m.calls.admit.length > 0)
  assert.ok(m.calls.admit.every((id) => id === 'Avery Stone#1'), 'Dana is never clicked while the setting is off')
})

test('ON: guests only -> nobody is admitted, nobody is made host, the bot stays', async () => {
  const m = meeting([bot(), who('Maria Lopez'), who('Casey'), who('Dr Avery Stone')])
  const { out } = await run(m, { admitAllStaff: true, waitMs: 10000 })
  assert.equal(out.ok, false)
  assert.deepEqual(m.calls.admit, [])
  assert.deepEqual(m.calls.makeHost, [])
  assert.equal(m.calls.leave, 0)
})

test('ON: a name two staff could fit is left in the waiting room, and the run says so once, without names in a public log', async () => {
  const entries = staff([member('U0EXAMPL10', 'Jordan Bishop')])
  const m = meeting([bot(), who('Jordan B')])
  const { out, lines } = await run(m, { admitAllStaff: true, staffEntries: entries, waitMs: 10000, redactNames: true })
  assert.equal(out.ok, false)
  assert.deepEqual(m.calls.admit, [])
  const said = lines.filter((l) => /could be more than one staff member/.test(l))
  assert.equal(said.length, 1)
  assert.ok(!/Jordan/.test(lines.join('\n')), 'no names in a public log')
})

test('ON: an entry that carries an excluded Slack id is never let in, even under its own full name', async () => {
  const entries = [{ name: 'Jordan Banks', aliases: [], slackId: FIRST }, { name: 'Front Desk', aliases: [], slackId: 'U0EXAMPL90' }]
  const m = meeting([bot(), inside('Jordan Banks'), who('Front Desk')])
  const { out } = await run(m, { admitAllStaff: true, staffEntries: entries })
  assert.equal(out.ok, true)
  assert.deepEqual(m.calls.admit, [])
  // control: the same meeting WITHOUT the exclusion does let that account in, so it is the exclusion that stops it
  const m2 = meeting([bot(), inside('Jordan Banks'), who('Front Desk')])
  await run(m2, { admitAllStaff: true, staffEntries: entries, excludeIds: [] })
  assert.deepEqual(m2.calls.admit, ['Front Desk#1'])
})

test('ON with the live Slack list: the list decides who is staff, and it is read once the meeting has started', async () => {
  const m = meeting([bot(), who('Avery Stone'), who('Jordan Banks'), who('Dana Gray'), who('Front Desk')])
  const { out } = await run(m, { admitAllStaff: true, staffEntries: undefined, getRosterNames: async () => rosterMembers() })
  assert.equal(out.ok, true)
  assert.deepEqual([...m.calls.admit].sort(), ['Avery Stone#1', 'Dana Gray#1', 'Jordan Banks#1'])
  assert.deepEqual(stillWaiting(m), ['Front Desk'])
})

test('ON with Slack unreadable: only the fixed host names are let in (nobody else is known to be staff)', async () => {
  const m = meeting([bot(), who('Jordan Banks'), who('Avery Stone'), who('Dana Gray')])
  const { out, lines } = await run(m, {
    admitAllStaff: true,
    staffEntries: undefined,
    backupHostNames: ['Avery Stone'],
    getRosterNames: async () => { throw new Error('Slack refused the member list (token_revoked)') },
  })
  assert.equal(out.ok, true)
  assert.deepEqual([...m.calls.admit].sort(), ['Avery Stone#1', 'Jordan Banks#1'])
  assert.deepEqual(stillWaiting(m), ['Dana Gray'])
  assert.ok(lines.some((l) => /Could not read the Slack member list/.test(l)))
})

test('dry run: nobody is admitted or made host; the log says who WOULD be let in (names only on a local run)', async () => {
  const people = [bot(), inside('Jordan Banks'), who('Avery Stone'), who('Maria Lopez')]
  const local = meeting(people)
  const a = await run(local, { admitAllStaff: true, dryHandover: true, redactNames: false })
  assert.equal(a.out.ok, true)
  assert.deepEqual(local.calls.admit, [])
  assert.deepEqual(local.calls.makeHost, [])
  assert.ok(a.lines.some((l) => /Dry run: would let Avery Stone in from the waiting room/.test(l)))
  const cloud = meeting(people)
  const b = await run(cloud, { admitAllStaff: true, dryHandover: true, redactNames: true })
  assert.ok(b.lines.some((l) => /Dry run: would let a staff member in/.test(l)))
  assert.ok(!/Avery|Jordan|Maria/.test(b.lines.join('\n')), 'no names in a public log')
})

test('a public (redacted) log never names the staff who were let in, and does not count them', async () => {
  const m = meeting([bot(), who('Jordan Banks'), who('Avery Stone'), who('Dana Gray')])
  const { out, lines } = await run(m, { admitAllStaff: true, redactNames: true })
  assert.equal(out.ok, true)
  const all = lines.join('\n')
  assert.ok(!/Avery|Dana|Jordan|Stone|Gray|Banks/.test(all))
  assert.ok(/Letting a staff member in/.test(all))
  assert.ok(!/Let in \d/.test(all))
})

// ---------------------------------------------------------------------------------------------------------------------------------
// The setting itself: default off, how it is read, and that it reaches the hand-over
// ---------------------------------------------------------------------------------------------------------------------------------

const baseEnv = { ZOOM_USERNAME: 'a@b.com', ZOOM_PASSWORD: 'x' }

test('ADMIT_ALL_STAFF is OFF by default; only clear "on" words switch it on; a typo stays off and is flagged', () => {
  assert.equal(loadConfig({ ...baseEnv }).admitAllStaff, false)
  for (const on of ['true', 'TRUE', ' True ', '1', 'yes', 'on', 'ON']) assert.equal(loadConfig({ ...baseEnv, ADMIT_ALL_STAFF: on }).admitAllStaff, true, `"${on}" is on`)
  for (const off of ['', ' ', '0', 'false', 'FALSE', 'no', 'off']) {
    const c = loadConfig({ ...baseEnv, ADMIT_ALL_STAFF: off })
    assert.equal(c.admitAllStaff, false, `"${off}" is off`)
    assert.equal(c.admitAllStaffUnclear, false, `"${off}" is a clear off`)
  }
  for (const typo of ['ture', 'enabled', 'tru', '2']) {
    const c = loadConfig({ ...baseEnv, ADMIT_ALL_STAFF: typo })
    assert.equal(c.admitAllStaff, false, `"${typo}" must NOT switch it on`)
    assert.equal(c.admitAllStaffUnclear, true, `"${typo}" is flagged`)
  }
})

test('a typo in ADMIT_ALL_STAFF never stops a run (it is only reported), and an env file may carry the setting', () => {
  assert.doesNotThrow(() => loadConfig({ ...baseEnv, ADMIT_ALL_STAFF: 'maybe' }))
  assert.ok(ALLOWED_KEYS.has('ADMIT_ALL_STAFF'))
})

test('the schedule check hands the setting and the exclusions to the hand-over', async () => {
  const PAGE = 'Today\n09:30 AM - 10:00 AM\nBea Example Admin Assistant Interview\nMeeting ID: 111 000 0003\nStart\nChat'
  const driver = { async listUpcoming() { return parseUpcoming(PAGE) } }
  const at = new Date(Date.UTC(2026, 9, 29, 9 + 5, 20))
  const seen = []
  const deps = { now: () => at, log: () => {}, runHandover: async (d, opts) => { seen.push(opts); return { ok: true, target: { userName: 'x' }, info: {} } } }
  const cfg = loadConfig({ ...baseEnv })
  await runTick(driver, cfg, { admitAllStaff: true, excludeIds: EXCLUDE }, deps)
  await runTick(driver, cfg, {}, deps)
  assert.equal(seen[0].admitAllStaff, true)
  assert.deepEqual(seen[0].excludeIds, EXCLUDE)
  assert.equal(seen[1].admitAllStaff, false, 'when the caller does not turn it on, it is off')
})

test('the workflow passes ADMIT_ALL_STAFF as a secret environment entry, only to the step after the tests', () => {
  const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'zoom-host-handover.yml'), 'utf8')
  assert.match(wf, /^\s+ADMIT_ALL_STAFF:\s*\$\{\{\s*secrets\.ADMIT_ALL_STAFF\s*\}\}\s*$/m)
  assert.ok(wf.indexOf('ADMIT_ALL_STAFF:') > wf.indexOf('run: npm test'))
  const failureStep = wf.slice(wf.indexOf('node src/report-failure.js'))
  assert.ok(!/ADMIT_ALL_STAFF/.test(failureStep), 'the failure-report step does not need it')
})

test('src/match-cli.js --admit-all tells you offline who would be let in (made-up names, nothing started)', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'src', 'match-cli.js'), '--roster', FIXTURE, '--exclude-ids', EXCLUDE.join(','), '--first-id', FIRST,
    '--people', 'Avery S., Front Desk, Dana, Jordan Banks, Dr Parker Lane', '--admit-all'], { encoding: 'utf8' })
  assert.match(r.stdout, /Staff admission: would let Avery S\., Jordan Banks in from the waiting room/)
  assert.ok(!/Front Desk in|Dana in|Parker/.test(r.stdout.split('\n')[0]), 'guests are not on the admit line')
  // without the flag, the line is not printed
  const plain = spawnSync(process.execPath, [path.join(root, 'src', 'match-cli.js'), '--roster', FIXTURE, '--first-id', FIRST, '--people', 'Jordan Banks'], { encoding: 'utf8' })
  assert.ok(!/Staff admission/.test(plain.stdout))
})
