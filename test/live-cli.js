'use strict'
// LIVE test of the real command: it runs `node src/cli.js --name Kemal-Test` as a separate process, joins a fake
// guest when the bot prints the invite link, and checks the command finishes by itself with exit code 0 and the
// guest ends up host. Always ends the test meeting afterwards.   npm run test:live-cli
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { loadEnvFiles, loadConfig } = require('../src/config')
const { sleep, log, GUEST_NAME, guestJoin, isHostNow, endMeetingFrom, refuseIfAnythingRunning } = require('./live-helpers')

if (!process.argv.includes('--yes')) {
  console.log('This starts a REAL Zoom meeting. Run it with:  npm run test:live-cli')
  process.exit(1)
}

const results = []
const check = (name, ok, detail = '') => {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`)
}

;(async () => {
  loadEnvFiles()
  const cfg = loadConfig()
  await refuseIfAnythingRunning(cfg)
  const guestProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'zoombot-guest-'))
  let guest = null
  let out = ''
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'cli.js'), '--name', GUEST_NAME, '--wait', '120'], {
    cwd: path.join(__dirname, '..'),
    env: process.env,
  })
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
  let joining = false
  const onData = async (d) => {
    const s = d.toString()
    out += s
    process.stdout.write(s.split('\n').filter(Boolean).map((l) => '  bot> ' + l.replace(/pwd=[^&\s]+/, 'pwd=...')).join('\n') + '\n')
    const m = /zoom\.us\/j\/(\d{9,12})/.exec(out)
    if (m && !joining) {
      joining = true
      guest = await guestJoin(cfg, m[1], false, guestProfile)
    }
  }
  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  const code = await Promise.race([exited, sleep(240000).then(() => 'timeout')])
  check('the command finished by itself', code !== 'timeout', 'timed out')
  check('exit code 0', code === 0, String(code))
  check('it printed the invite link for Kemal', /Send this link to Kemal-Test/.test(out))
  check('it reported the hand-over', /Done\. Kemal-Test is the host and the bot has left\./.test(out))
  check('it never printed the password', !out.includes(cfg.password))
  if (guest) {
    await sleep(1500)
    check('the guest now has the host controls', await isHostNow(guest.page))
  } else {
    check('a guest joined', false)
  }

  // cleanup: end the test meeting for everyone
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
