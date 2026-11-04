'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { runTick } = require('../../src/tick')
const { parseUpcoming } = require('../../src/upcoming')
const { scrub, stamp, makeLog } = require('../../src/log')
const { loadConfig } = require('../../src/config')
const { encodeSession } = require('../../src/session')

const PAGE = 'Today\n09:30 AM - 10:00 AM\nBea Example Admin Assistant Interview\nMeeting ID: 111 000 0003\nStart\nChat\n11:00 AM - 11:30 AM\nBooking with Jo Booker\nMeeting ID: 111 000 0005\nStart\nChat'
const at = (h, m) => new Date(Date.UTC(2026, 9, 29, h + 5, m))
const baseEnv = { ZOOM_USERNAME: 'a@b.com', ZOOM_PASSWORD: 'x' }
const cloud = { CI: 'true', NEW_HOST_NAME: 'Kemal Example' }

const makeDriver = (text = PAGE) => ({ calls: [], async listUpcoming() { this.calls.push('list'); return parseUpcoming(text) } })

function setup(now, env = {}) {
  const cfg = loadConfig({ ...baseEnv, ...env })
  const lines = []
  const handovers = []
  const deps = {
    now: () => now,
    log: (m) => lines.push(m),
    runHandover: async (driver, opts) => { handovers.push(opts); return { ok: true, target: { userName: 'Kemal' }, info: {} } },
  }
  return { cfg, lines, handovers, deps }
}

test('tick: nothing due -> nothing is started', async () => {
  const { cfg, lines, handovers, deps } = setup(at(8, 0))
  const r = await runTick(makeDriver(), cfg, {}, deps)
  assert.equal(r.action, 'nothing-due')
  assert.equal(handovers.length, 0)
  assert.match(lines[0], /1 meeting\(s\)|2 meeting\(s\)/)
  assert.match(lines[0], /0 due/)
})

test('tick: a meeting 10 minutes away is started by its number, handing host to Kemal', async () => {
  const { cfg, handovers, deps } = setup(at(9, 20))
  const r = await runTick(makeDriver(), cfg, {}, deps)
  assert.equal(r.action, 'handover')
  assert.equal(handovers.length, 1)
  assert.deepEqual(handovers[0].start, { meetingId: '1110000003' })
  assert.equal(handovers[0].newHostName, 'Kemal')
  assert.equal(handovers[0].waitMs, 1800 * 1000)
})

test('tick: the new host name and wait time come from the settings', async () => {
  const { cfg, handovers, deps } = setup(at(9, 20), { NEW_HOST_NAME: 'kemal', WAIT_FOR_NEW_HOST_SECONDS: '600' })
  await runTick(makeDriver(), cfg, {}, deps)
  assert.equal(handovers[0].newHostName, 'kemal')
  assert.equal(handovers[0].waitMs, 600000)
})

test('tick: --dry-run says what would happen and starts nothing', async () => {
  const { cfg, handovers, deps } = setup(at(9, 20))
  const r = await runTick(makeDriver(), cfg, { dryRun: true }, deps)
  assert.equal(r.action, 'dry-run')
  assert.equal(r.due.length, 1)
  assert.equal(handovers.length, 0)
})

test("tick: the filter keeps non-interview meetings out unless it is switched off", async () => {
  let s = setup(at(10, 52))
  assert.equal((await runTick(makeDriver(), s.cfg, {}, s.deps)).action, 'nothing-due')
  s = setup(at(10, 52), { MEETING_FILTER: '.*' })
  assert.equal((await runTick(makeDriver(), s.cfg, {}, s.deps)).action, 'handover')
  assert.deepEqual(s.handovers[0].start, { meetingId: '1110000005' })
})

test('tick: the log never contains a meeting title or number', async () => {
  const { cfg, lines, deps } = setup(at(9, 20))
  await runTick(makeDriver(), cfg, {}, deps)
  const all = lines.join('\n')
  assert.ok(!/Bea|Example|Booker/.test(all), 'no names')
  assert.ok(!/\d{9,}/.test(all.replace(/\s/g, '')), 'no meeting numbers')
})

test('tick: a handover that did not finish is reported, not hidden', async () => {
  const { cfg, deps } = setup(at(9, 20))
  deps.runHandover = async () => ({ ok: false, reason: 'new-host-not-found', detail: 'nobody came' })
  const r = await runTick(makeDriver(), cfg, {}, deps)
  assert.equal(r.ok, false)
  assert.equal(r.action, 'handover')
})

test('tick: if the list cannot be read the error surfaces (the run fails loudly)', async () => {
  const { cfg, deps } = setup(at(9, 20))
  const driver = { async listUpcoming() { throw new Error('Zoom\'s Upcoming meetings page did not load.') } }
  await assert.rejects(runTick(driver, cfg, {}, deps), /did not load/)
})

// ---- the public-log rules ----
test('scrub: links and meeting numbers are masked', () => {
  assert.equal(scrub('Send https://us06web.zoom.us/j/1110000003?pwd=abc to Kemal'), 'Send [link] to Kemal')
  assert.equal(scrub('Meeting started (ID 1110000003).'), 'Meeting started (ID [id]).')
  assert.equal(scrub('Done at 9:30'), 'Done at 9:30')
})

test('log: lines are stamped in Jamaica time, whatever the computer\'s zone', () => {
  assert.equal(stamp(new Date(Date.UTC(2026, 9, 29, 14, 20, 5)), 'America/Jamaica'), '09:20:05 Jamaica')
  const out = []
  makeLog({ quiet: true }, (l) => out.push(l), () => new Date(Date.UTC(2026, 9, 29, 14, 20, 5)))('Link: https://zoom.us/j/12345678901')
  assert.equal(out[0], '[09:20:05 Jamaica] Link: [link]')
})

// ---- settings for the cloud run ----
test('config: a saved session alone is enough (no password needed on the cloud)', () => {
  const session = encodeSession([{ name: 'a', value: 'b', domain: '.zoom.us', path: '/' }])
  const c = loadConfig({ ZOOM_SESSION: session })
  assert.equal(c.session.length, 1)
  assert.equal(c.canSignInWithPassword, false)
})

test('config: a broken session is refused without repeating it', () => {
  assert.throws(() => loadConfig({ ZOOM_SESSION: 'not-a-session' }), (e) => /not a valid saved session/.test(e.message) && !e.message.includes('not-a-session'))
})

test('config: cloud runs are quiet, keep nothing and never write screenshots; local runs are not', () => {
  assert.equal(loadConfig({ ...baseEnv, ...cloud, CI: undefined, GITHUB_ACTIONS: 'true' }).quiet, true)
  assert.equal(loadConfig({ ...baseEnv, ...cloud }).ci, true)
  const local = loadConfig(baseEnv)
  assert.equal(local.ci, false)
  assert.equal(local.quiet, false)
  assert.match(local.profileDir, /\.profile$/)
  assert.doesNotMatch(loadConfig({ ...baseEnv, ...cloud }).profileDir, /\.profile$/)
})

test('config: schedule settings have the agreed defaults and refuse nonsense', () => {
  const c = loadConfig(baseEnv)
  assert.equal(c.leadMinutes, 10)
  assert.equal(c.lateMinutes, 5)
  assert.equal(c.timeZone, 'America/Jamaica')
  assert.ok(c.meetingFilter.test('Ann Admin Assistant INTERVIEW'))
  assert.ok(!c.meetingFilter.test('Team lunch'))
  assert.equal(loadConfig({ ...baseEnv, MEETING_FILTER: '.*' }).meetingFilter, null)
  assert.throws(() => loadConfig({ ...baseEnv, MEETING_FILTER: '(' }), /not a valid pattern/)
  assert.throws(() => loadConfig({ ...baseEnv, LEAD_MINUTES: '-1' }), /LEAD_MINUTES/)
  assert.throws(() => loadConfig({ ...baseEnv, LATE_MINUTES: 'abc' }), /LATE_MINUTES/)
  assert.throws(() => loadConfig({ ...baseEnv, ZOOM_TIMEZONE: 'Nowhere/Land' }), /time zone/)
})

// ---- fixes from the independent security review ----
test('scrub: meeting numbers written with spaces or dashes, and 12-digit ones, are masked too', () => {
  assert.equal(scrub('ID 111 000 0003 ok'), 'ID [id] ok')
  assert.equal(scrub('ID 111-000-0003 ok'), 'ID [id] ok')
  assert.equal(scrub('ID 123456789012'), 'ID [id]')
  assert.equal(scrub('at 09:20:05, waited 2700 seconds, run 12'), 'at 09:20:05, waited 2700 seconds, run 12', 'times and small numbers are left alone')
})

test('tick: a public (quiet) log says only whether something was due, not how many meetings or when', async () => {
  for (const [now, expected] of [[at(8, 0), /nothing due\.$/], [at(9, 20), /a meeting is due\.$/]]) {
    const { cfg, lines, deps } = setup(now, cloud)
    assert.equal(cfg.quiet, true)
    await runTick(makeDriver(), cfg, {}, deps)
    const all = lines.join('\n')
    assert.match(lines[0], expected)
    assert.ok(!/\d+ meeting\(s\)|begins at|in \d+ min/.test(all), 'no counts and no start times in a public log')
    assert.ok(!/\d{2}:\d{2} [AP]M - /.test(all))
  }
})

test('env files: only the bot\'s own settings are read; any other secret in the file is ignored', () => {
  const fs = require('fs')
  const os = require('os')
  const path = require('path')
  const { loadDotEnv, ALLOWED_KEYS } = require('../../src/config')
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-')), '.env')
  fs.writeFileSync(f, 'ZOOM_USERNAME=a@b.com\nDATABASE_URL=postgres://secret\nSLACK_BOT_TOKEN=xoxb-nope\nNEW_HOST_NAME=Kemal\n')
  const env = {}
  loadDotEnv(f, env)
  assert.deepEqual(Object.keys(env).sort(), ['NEW_HOST_NAME', 'ZOOM_USERNAME'])
  assert.ok(ALLOWED_KEYS.has('ZOOM_SESSION') && !ALLOWED_KEYS.has('DATABASE_URL'))
})

test('source rules from the review: Chrome gets no login, Make Host names the exact person, the bot never closes while host', () => {
  const fs = require('fs')
  const path = require('path')
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8')
  const driver = src('browserDriver.js')
  assert.ok(driver.includes('env = chromeEnv(process.env)'), 'Chrome is started with the filtered environment')
  const filtered = require('../../src/browserDriver').chromeEnv({ ZOOM_SESSION: 'a', ZOOM_PASSWORD: 'b', ZOOM_USERNAME: 'c', PATH: 'p' })
  assert.deepEqual(Object.keys(filtered), ['PATH'], 'Chrome gets no login')
  assert.ok(driver.includes('change the host to ([^?]{1,120})\\?/'), 'the confirmation must name exactly the intended person')
  // fail closed and scoped: no looser fallback, and the text is read from the dialog around the Yes button, not the page
  assert.ok(!/text\.includes\(`change the host to/.test(driver), 'no looser "includes" fallback for the confirmation')
  assert.ok(/yes\.parentElement/.test(driver) && !/document\.body\.innerText[^\n]*change the host/.test(driver), 'the confirmation is read from its own dialog')
  const cli = src('cli.js')
  assert.match(cli, /process\.on\('unhandledRejection'/)
  assert.match(cli, /process\.on\('uncaughtException'/)
  assert.match(cli, /require\('\.\/stay'\)/, 'the cli uses the tested stay module')
  assert.ok(!/driver\.close\(\)/.test(src('stay.js')), 'staying in the meeting must not close the browser (not even on the cloud)')
})

test('stay: the run is marked FAILED up front, and a browser that dies while waiting ends the run with exit code 1 (never green)', async () => {
  const { stayInMeeting } = require('../../src/stay')
  const handlers = {}
  const driver = { browser: { on: (event, fn) => { handlers[event] = fn } } }
  const lines = []
  const oldCode = process.exitCode
  const realExit = process.exit
  let exitedWith = null
  process.exit = (c) => { exitedWith = c }
  try {
    stayInMeeting(driver, { ci: true }, (m) => lines.push(m), 'Kemal did not arrive.') // waits forever: deliberately not awaited
    await new Promise((r) => setImmediate(r))
    assert.equal(process.exitCode, 1, 'failed from the very start, so even a silent exit cannot look green')
    assert.equal(typeof handlers.disconnected, 'function', 'it watches the browser')
    assert.match(lines.join(' '), /staying in the meeting as host/)
    assert.match(lines.join(' '), /time limit/, 'on the cloud it says the run limit ends it')
    handlers.disconnected()
    assert.equal(exitedWith, 1)
  } finally { process.exit = realExit; process.exitCode = oldCode }
})

test('stay: on your own computer it says Ctrl+C, and works even with no browser object', async () => {
  const { stayInMeeting } = require('../../src/stay')
  const lines = []
  const oldCode = process.exitCode
  try {
    stayInMeeting({}, { ci: false }, (m) => lines.push(m), 'why')
    await new Promise((r) => setImmediate(r))
    assert.match(lines.join(' '), /Ctrl\+C/)
  } finally { process.exitCode = oldCode }
})

test('scrub: a number is masked even when letters or an underscore touch it', () => {
  assert.equal(scrub('id_111000000003'), 'id_[id]')
  assert.equal(scrub('ID111000000003x'), 'ID[id]x')
  assert.equal(scrub('room111-000-0003.'), 'room[id].')
  assert.equal(scrub('2700 seconds'), '2700 seconds')
})

test('handover: names are redacted unless the caller explicitly allows them', async () => {
  const { runHandover } = require('../../src/handover')
  const lines = []
  const me = { userId: 'Bot#1', userName: 'Bot', isMe: true, isHost: true, waiting: false }
  const kemal = { userId: 'Kemal Example#1', userName: 'Kemal Example', isMe: false, isHost: false, waiting: true }
  let n = 0
  const driver = {
    async join() { return { meetingId: '1', link: '' } },
    async people() { n++; return [me, { ...kemal, waiting: n < 2, isHost: n > 3 }].map((p) => (p.isMe && n > 3 ? { ...p, isHost: false } : p)) },
    async admit() {}, async makeHost() {}, async leave() {},
  }
  let t = 0
  const out = await runHandover(driver, { newHostName: 'Kemal', waitMs: 60000 }, { now: () => t, sleep: async (ms) => { t += ms }, log: (m) => lines.push(m) })
  assert.equal(out.ok, true)
  assert.ok(!lines.join('\n').includes('Example'), 'with no redactNames option the display name is not logged')
})

test('cloud: a run with no host name set refuses to start (a first name alone would let lookalikes fit)', () => {
  assert.throws(() => loadConfig({ ...baseEnv, CI: 'true' }), /NEW_HOST_NAME must be set on a cloud run/)
  assert.throws(() => loadConfig({ ...baseEnv, GITHUB_ACTIONS: 'true', NEW_HOST_NAME: '   ' }), /NEW_HOST_NAME must be set/)
  assert.equal(loadConfig({ ...baseEnv, ...cloud }).newHostName, 'Kemal Example')
  assert.equal(loadConfig(baseEnv).newHostName, 'Kemal', 'on your own computer the default still works')
})

test('cloud: a public log never says the host\'s name, even the configured one', async () => {
  const { runHandover } = require('../../src/handover')
  const lines = []
  const me = { userId: 'Bot#1', userName: 'Bot', isMe: true, isHost: true, waiting: false }
  let n = 0
  const driver = {
    async join() { return { meetingId: '1', link: '' } },
    async people() { n++; return [n > 3 ? { ...me, isHost: false } : me, { userId: 'Kemal Example#1', userName: 'Kemal Example', isMe: false, isHost: n > 3, waiting: n < 2 }] },
    async admit() {}, async makeHost() {}, async leave() {},
  }
  let t = 0
  const out = await runHandover(driver, { newHostName: 'Kemal Example', waitMs: 60000, redactNames: true }, { now: () => t, sleep: async (ms) => { t += ms }, log: (m) => lines.push(m) })
  assert.equal(out.ok, true)
  assert.ok(!/Kemal|Example/.test(lines.join('\n')), 'no name of any kind in a public log')
  const never = await runHandover({ ...driver, async people() { return [me] } }, { newHostName: 'Kemal Example', waitMs: 4000, redactNames: true }, { now: () => t, sleep: async (ms) => { t += ms }, log: () => {} })
  assert.ok(!/Kemal|Example/.test(never.detail), 'the failure message is generic too')
})
