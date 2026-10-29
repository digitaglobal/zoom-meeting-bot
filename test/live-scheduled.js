'use strict'
// LIVE test of the real command on a meeting that is already on the schedule:
//   node src/cli.js --meeting <id> --name Kemal-Test
// A fake guest "Kemal-Test" joins when the bot starts the meeting; the test checks the guest ends up host and the
// command finishes by itself. It REFUSES to run if any meeting on the account is already in progress, so it can
// never disturb a real one, and it only ever ends the test meeting it started itself.
//   npm run test:live-scheduled -- --meeting 123456789 --yes
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { loadEnvFiles, loadConfig } = require('../src/config')
const { ZoomBrowserDriver } = require('../src/browserDriver')
const { isStartable } = require('../src/upcoming')
const { sleep, log, GUEST_NAME, guestJoin, isHostNow, endMeetingFrom } = require('./live-helpers')

const argv = process.argv.slice(2)
const meetingId = argv[argv.indexOf('--meeting') + 1]
if (!argv.includes('--yes') || !/^\d{9,11}$/.test(meetingId || '')) {
  console.log('This starts a REAL Zoom meeting. Run it with:  npm run test:live-scheduled -- --meeting <number> --yes')
  process.exit(1)
}

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`) }

;(async () => {
  loadEnvFiles()
  const cfg = loadConfig()

  // safety: nothing may be running, and the test meeting must be on the schedule and not started
  const probe = new ZoomBrowserDriver(cfg, () => {})
  let list
  try { list = await probe.listUpcoming() } finally { await probe.close() }
  const running = list.filter((m) => m.buttons.includes('End') || m.buttons.includes('Join'))
  if (running.length) { console.log(`REFUSING to run: ${running.length} meeting(s) on the account are in progress.`); process.exit(2) }
  const target = list.find((m) => m.id === meetingId)
  if (!target || !isStartable(target)) { console.log('REFUSING to run: that meeting is not on today\'s schedule, or it is already started.'); process.exit(2) }
  console.log(`Nothing is running. Starting the scheduled test meeting "${target.title}" (${target.start}).`)

  const guestProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'zoombot-guest-'))
  let guest = null
  let out = ''
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), '--meeting', meetingId, '--name', GUEST_NAME, '--wait', '120'], { cwd: path.join(__dirname, '..'), env: process.env })
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  let joining = false
  const onData = async (d) => {
    const s = d.toString()
    out += s
    process.stdout.write(s.split('\n').filter(Boolean).map((l) => '  bot> ' + l.replace(/pwd=[^&\s]+/, 'pwd=...')).join('\n') + '\n')
    const m = /zoom\.us\/j\/(\d{9,12})/.exec(out)
    if (m && !joining) { joining = true; guest = await guestJoin(cfg, m[1], false, guestProfile) }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const code = await Promise.race([exited, sleep(240000).then(() => 'timeout')])
  check('the command finished by itself', code !== 'timeout', 'timed out')
  check('exit code 0', code === 0, String(code))
  check('it started the SCHEDULED meeting (same number as on the schedule)', out.includes(`(ID ${meetingId})`) || out.includes(meetingId), 'meeting number not seen in the output')
  check('it reported the hand-over', /Done\. Kemal-Test is the host and the bot has left\./.test(out))
  check('it never printed the password', !out.includes(cfg.password))
  if (guest) { await sleep(1500); check('the guest now has the host controls', await isHostNow(guest.page)) } else check('a guest joined', false)

  // cleanup: end the test meeting for everyone (test harness only; the scheduled entry itself stays)
  let ended = false
  if (guest) ended = await endMeetingFrom(guest.page)
  log(ended ? 'Test meeting ended for everyone.' : 'WARNING: could not end the test meeting automatically. Check Zoom and end it by hand.')
  if (code === 'timeout') { try { child.kill() } catch { /* gone */ } }
  try { if (guest) await guest.browser.close() } catch { /* closed */ }
  try { fs.rmSync(guestProfile, { recursive: true, force: true }) } catch { /* best effort */ }
  const failed = results.filter((x) => !x).length
  console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
