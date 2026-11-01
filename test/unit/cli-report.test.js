'use strict'
// Runs the real src/cli.js in a child process against a pretend Zoom and a pretend network (helpers/cli-fakes.js):
// checks WHEN a private report is sent, what is in it, and that nothing private reaches the log.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn, spawnSync } = require('child_process')
const { encodeSession } = require('../../src/session')
const { markerPath } = require('../../src/report')

const ROOT = path.join(__dirname, '..', '..')
const FAKES = path.join(__dirname, 'helpers', 'cli-fakes.js')
const HOOK = 'https://hooks.example.com/catch/abc123SECRETtoken'

// Every pretend run gets its OWN temp folder. In the real workflow these tests run on the same machine, earlier in the same
// job, as the "run failed" step: if they left the real "already reported" marker behind, that alert would stay silent.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-cli-'))
const REAL_MARKER = markerPath(process.env)
const markerExistedBefore = fs.existsSync(REAL_MARKER)
const OUTSIDE_MARKER = path.join(os.tmpdir(), 'zoom-bot-reported-99-1') // where a pretend run (run id 99) would write if it were NOT isolated
const outsideMarkerExistedBefore = fs.existsSync(OUTSIDE_MARKER)

const env = (extra = {}) => ({
  ...process.env,
  RUNNER_TEMP: SANDBOX, TEMP: SANDBOX, TMP: SANDBOX, TMPDIR: SANDBOX,
  CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '99',
  ZOOM_SESSION: encodeSession([{ name: 'a', value: 'b', domain: '.zoom.us', path: '/' }]),
  NEW_HOST_NAME: 'Kemal Example', REPORT_WEBHOOK_URL: HOOK,
  MEETING_FILTER: 'interview', LEAD_MINUTES: '15', LATE_MINUTES: '5', ZOOM_TIMEZONE: 'America/Jamaica', WAIT_FOR_NEW_HOST_SECONDS: '3600',
  FAKE_SCENARIO: 'ok', ...extra,
})
const run = (args, extra) => {
  const r = spawnSync(process.execPath, ['--require', FAKES, path.join(ROOT, 'src', 'cli.js'), ...args], { cwd: ROOT, env: env(extra), encoding: 'utf8', timeout: 60000 })
  const lines = `${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/)
  return { code: r.status, reports: lines.filter((l) => l.startsWith('REPORT ')).map((l) => JSON.parse(l.slice(7))), log: lines.filter((l) => !l.startsWith('REPORT ')).join('\n') }
}
const assertLogIsClean = (log) => {
  for (const secret of ['abc123SECRETtoken', 'hooks.example.com', 'Kemal', 'Bea', 'Example', '1110000003']) assert.ok(!log.includes(secret), `the log must not contain "${secret}"`)
}

test('cli: a finished hand-over sends one report naming the interview, and the log stays clean', () => {
  const r = run(['--tick'])
  assert.equal(r.code, 0)
  assert.equal(r.reports.length, 1)
  assert.equal(r.reports[0].url, HOOK)
  assert.equal(r.reports[0].redirect, 'error')
  const b = r.reports[0].body
  assert.equal(b.event, 'handover'); assert.equal(b.ok, true)
  assert.equal(b.interview, 'Bea Example Admin Assistant Interview'); assert.equal(b.starts, '09:30 AM')
  assert.equal(b.when, 'Thu, Oct 29, 9:20 AM')
  assert.equal(b.run, 'https://github.com/o/r/actions/runs/99')
  assert.ok(!/Kemal/.test(JSON.stringify(b)), 'the new host\'s name is never in a report')
  assertLogIsClean(r.log)
})

test('cli: a login check (dry run) and a run with nothing due send no report', () => {
  assert.equal(run(['--tick', '--dry-run']).reports.length, 0)
  const none = run(['--tick'], { LEAD_MINUTES: '0', LATE_MINUTES: '0' })
  assert.equal(none.code, 0); assert.equal(none.reports.length, 0)
})

test('cli: with no report address nothing is sent and the hand-over still works', () => {
  const r = run(['--tick'], { REPORT_WEBHOOK_URL: '' })
  assert.equal(r.code, 0); assert.equal(r.reports.length, 0)
})

test('cli: a bad (non-https) address is flagged without being repeated, and the hand-over still works', () => {
  const r = run(['--tick'], { REPORT_WEBHOOK_URL: 'http://insecure.example.com/secretpath' })
  assert.equal(r.code, 0); assert.equal(r.reports.length, 0)
  assert.match(r.log, /REPORT_WEBHOOK_URL is set but is not a valid https address/)
  assert.ok(!r.log.includes('insecure.example.com') && !r.log.includes('secretpath'))
})

test('cli: a problem on a timer-started run is reported and the run fails; on the backup schedule it is NOT reported (no repeat every 10 minutes)', () => {
  const asked = run(['--tick'], { FAKE_SCENARIO: 'error' })
  assert.equal(asked.code, 1)
  assert.equal(asked.reports.length, 1)
  assert.equal(asked.reports[0].body.event, 'error'); assert.equal(asked.reports[0].body.ok, false)
  assert.match(asked.reports[0].body.text, /export-session/)
  assertLogIsClean(asked.log)
  const backup = run(['--tick'], { FAKE_SCENARIO: 'error', GITHUB_EVENT_NAME: 'schedule' })
  assert.equal(backup.code, 1); assert.equal(backup.reports.length, 0)
})

test('cli: if the new host never comes, the owner is told BEFORE the bot settles in to wait as host', async () => {
  const child = spawn(process.execPath, ['--require', FAKES, path.join(ROOT, 'src', 'cli.js'), '--tick'], { cwd: ROOT, env: env({ FAKE_SCENARIO: 'stuck', WAIT_FOR_NEW_HOST_SECONDS: '10', GITHUB_EVENT_NAME: 'schedule' }) })
  let out = ''
  const report = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('no report within 40 seconds')) }, 40000)
    child.stdout.on('data', (d) => {
      out += d
      const line = out.split(/\r?\n/).find((l) => l.startsWith('REPORT '))
      if (line) { clearTimeout(timer); resolve(JSON.parse(line.slice(7))) }
    })
    child.on('exit', () => { clearTimeout(timer); if (!out.includes('REPORT ')) reject(new Error('the bot ended without reporting')) })
  })
  const stillRunning = child.exitCode === null // it is waiting in the meeting as host, not finished
  child.kill()
  assert.equal(stillRunning, true)
  assert.equal(report.body.event, 'handover'); assert.equal(report.body.ok, false)
  assert.equal(report.body.reason, 'new-host-not-found')
  assert.match(report.body.text, /staying in the meeting as host/)
  assert.ok(!/Kemal/.test(JSON.stringify(report.body)))
  assertLogIsClean(out.split(/\r?\n/).filter((l) => !l.startsWith('REPORT ')).join('\n'))
})

test('cli: "--test-report" sends one clearly marked test report and never opens Zoom', () => {
  const r = run(['--tick', '--test-report'], { FAKE_SCENARIO: 'error' }) // the pretend Zoom would throw if it were touched
  assert.equal(r.code, 0)
  assert.equal(r.reports.length, 1)
  const b = r.reports[0].body
  assert.equal(b.event, 'test'); assert.equal(b.ok, true)
  assert.match(b.interview, /^TEST/); assert.match(b.text, /No interview was started/)
  assertLogIsClean(r.log)
})

test('cli: "--test-report" with no report address says so and fails (so the button never looks green by mistake)', () => {
  const r = run(['--tick', '--test-report'], { REPORT_WEBHOOK_URL: '' })
  assert.equal(r.code, 1); assert.equal(r.reports.length, 0)
  assert.match(r.log, /nothing to test/)
})

test('tests: the pretend runs never left the REAL "already reported" marker behind (it would silence the real failure alert)', () => {
  assert.equal(fs.existsSync(REAL_MARKER), markerExistedBefore)
  assert.equal(fs.existsSync(OUTSIDE_MARKER), outsideMarkerExistedBefore, 'the pretend runs wrote into the machine\'s real temp folder instead of their own')
  assert.ok(fs.readdirSync(SANDBOX).some((f) => f.startsWith('zoom-bot-reported-')), 'the pretend runs did write their marker, but in their own folder')
})
