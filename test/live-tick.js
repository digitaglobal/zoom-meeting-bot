'use strict'
// LIVE test of the whole cloud flow on this computer: the schedule check ("--tick") run exactly the way GitHub runs
// it (CI mode: empty profile, saved session only, NO password, quiet log), against a throwaway scheduled meeting.
// A fake guest "Kemal-Test" joins; the test checks the hand-over and that the (public-safe) log leaks nothing.
// Refuses to run if any meeting is in progress. Only ever ends the test meeting it started.
//   npm run test:live-tick -- --meeting 123456789 --title "TEST - Bot" --yes
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { loadEnvFiles, loadConfig } = require('../src/config')
const { ZoomBrowserDriver } = require('../src/browserDriver')
const { isStartable } = require('../src/upcoming')
const { sleep, log, GUEST_NAME, guestJoin, isHostNow, endMeetingFrom } = require('./live-helpers')

const argv = process.argv.slice(2)
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined }
const meetingId = arg('--meeting')
const title = arg('--title')
if (!argv.includes('--yes') || !/^\d{9,11}$/.test(meetingId || '') || !title) {
  console.log('This starts a REAL Zoom meeting. Run it with:  npm run test:live-tick -- --meeting <number> --title "<text in its title>" --yes')
  process.exit(1)
}

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`) }

;(async () => {
  loadEnvFiles()
  const cfg = loadConfig()
  const sessionFile = path.join(os.homedir(), '.zoom-meeting-bot', 'session.b64')
  if (!fs.existsSync(sessionFile)) { console.log('Run "npm run export-session" first.'); process.exit(1) }

  const probe = new ZoomBrowserDriver(cfg, () => {})
  let list
  try { list = await probe.listUpcoming() } finally { await probe.close() }
  const running = list.filter((m) => m.buttons.includes('End') || m.buttons.includes('Join'))
  if (running.length) { console.log(`REFUSING to run: ${running.length} meeting(s) on the account are in progress.`); process.exit(2) }
  const target = list.find((m) => m.id === meetingId)
  if (!target || !isStartable(target)) { console.log('REFUSING to run: that meeting is not on today\'s schedule, or it is already started.'); process.exit(2) }

  const guestProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'zoombot-guest-'))
  const cloudProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'zoombot-cloud-'))
  const env = {
    ...process.env,
    CI: 'true', // the cloud settings: quiet log, no screenshots, throwaway profile
    PROFILE_DIR: cloudProfile,
    ZOOM_SESSION: fs.readFileSync(sessionFile, 'utf8').trim(),
    ZOOM_USERNAME: '', ZOOM_PASSWORD: '', // the cloud run has no password
    MEETING_FILTER: title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    LEAD_MINUTES: '60', // the test meeting is scheduled well ahead; this makes it "due" now
    NEW_HOST_NAME: GUEST_NAME,
    WAIT_FOR_NEW_HOST_SECONDS: '120',
  }
  let guest = null
  let out = ''
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), '--tick'], { cwd: path.join(__dirname, '..'), env })
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  let joining = false
  const onData = async (d) => {
    const s = d.toString()
    out += s
    process.stdout.write(s.split('\n').filter(Boolean).map((l) => '  cloud> ' + l).join('\n') + '\n')
    if (/Meeting started .*Waiting for the new host/.test(out) && !joining) { joining = true; guest = await guestJoin(cfg, meetingId, false, guestProfile) }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const code = await Promise.race([exited, sleep(240000).then(() => 'timeout')])
  check('the command finished by itself', code !== 'timeout', 'timed out')
  check('exit code 0', code === 0, String(code))
  check('it signed in from the saved session alone (no password typed)', /Loaded the saved Zoom session/.test(out) && !/Signing in to Zoom/.test(out))
  check('it found the meeting on the schedule and started it', /a meeting is due\./.test(out) && /Meeting started/.test(out))
  check('it reported the hand-over', /Done\. The new host is the host and the bot has left\./.test(out))
  check('the log shows Jamaica time', /\[\d\d:\d\d:\d\d Jamaica\]/.test(out))
  check('the log has no link, no meeting number, no meeting title and no name (it is public)', !/https?:\/\//.test(out) && !new RegExp(meetingId).test(out) && !out.includes(target.title) && !/Kemal/i.test(out))
  check('the log has no password or session text', !out.includes(env.ZOOM_SESSION.slice(0, 40)) && !(cfg.password && out.includes(cfg.password)))
  if (guest) { await sleep(1500); check('the guest now has the host controls', await isHostNow(guest.page)) } else check('a guest joined', false)

  let ended = false
  if (guest) ended = await endMeetingFrom(guest.page)
  log(ended ? 'Test meeting ended for everyone.' : 'WARNING: could not end the test meeting automatically. Check Zoom and end it by hand.')
  if (code === 'timeout') { try { child.kill() } catch { /* gone */ } }
  try { if (guest) await guest.browser.close() } catch { /* closed */ }
  for (const d of [guestProfile, cloudProfile]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
  const failed = results.filter((x) => !x).length
  console.log(failed === 0 ? '\nALL PASSED' : `\n${failed} FAILED`)
  process.exit(failed === 0 ? 0 : 1)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
