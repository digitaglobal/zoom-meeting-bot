'use strict'
// LIVE end-to-end test against REAL Zoom. It starts a real meeting on the Zoom account in .env.local, has a
// second browser join as a guest named "Kemal-Test", and checks the bot admits them, makes them host, and leaves.
// The test then ends the meeting for everyone, even if a step failed, so nothing is left running.
//
//   npm run test:live            (add --hidden, --hidden-bot or --hidden-guest to run browsers without windows)
//
// Note: if the account auto-records meetings, this creates a short cloud recording.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadEnvFiles, loadConfig } = require('../src/config')
const { ZoomBrowserDriver } = require('../src/browserDriver')
const { runHandover } = require('../src/handover')
const { sleep, log, guestJoin, isHostNow, endMeetingFrom, refuseIfAnythingRunning } = require('./live-helpers')

if (!process.argv.includes('--yes')) {
  console.log('This starts a REAL Zoom meeting. Run it with:  npm run test:live')
  process.exit(1)
}

const results = []
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : '  -> ' + detail}`) }

const GUEST_NAME = 'Kemal-Test'

;(async () => {
  loadEnvFiles()
  const cfg = loadConfig()
  await refuseIfAnythingRunning(cfg)
  cfg.newHostName = GUEST_NAME
  cfg.waitSeconds = 120
  const hideBot = process.argv.includes('--hidden') || process.argv.includes('--hidden-bot')
  const hideGuest = process.argv.includes('--hidden') || process.argv.includes('--hidden-guest')
  if (hideBot) cfg.headed = false
  log(`Bot browser: ${cfg.headed ? 'visible' : 'hidden'}, guest browser: ${hideGuest ? 'hidden' : 'visible'}. The bot profile is ${fs.existsSync(cfg.profileDir) ? 'kept from earlier runs' : 'fresh (the bot must sign in)'}.`)

  const driver = new ZoomBrowserDriver(cfg, log)
  const guestProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'zoombot-guest-'))
  let guest = null
  let result = null
  let guestIsHost = false
  try {
    result = await runHandover(driver, {
      newHostName: cfg.newHostName,
      waitMs: cfg.waitSeconds * 1000,
      confirmMs: 25000,
      onStarted: async (info) => {
        log(`Invite link (what Kemal would be sent): ${info.link.replace(/pwd=[^&\s]+/, 'pwd=...')}`)
        guest = await guestJoin(cfg, info.meetingId, hideGuest, guestProfile)
      },
    }, { log })

    check('the handover reported success', result.ok === true, result.detail || result.reason)
    check('the person made host was the guest', !!result.target && /Kemal-Test/.test(result.target.userName), result.target && result.target.userName)
    check('the bot left the meeting (its browser is back on the Zoom home screen)', !/\/wc\/\d+\/start/.test(driver.page.url()), driver.page.url())
    if (guest) {
      await sleep(2500)
      guestIsHost = await isHostNow(guest.page)
      check('the guest now has the host controls', guestIsHost)
    }
  } catch (e) {
    check('the run finished without an error', false, e.message)
    const file = await driver.shot('live-error')
    if (file) log(`Screenshot: ${file}`)
  } finally {
    if (guest && !(result && result.ok)) {
      try {
        fs.mkdirSync(cfg.screenshotDir, { recursive: true })
        const gfile = path.join(cfg.screenshotDir, `live-guest-${Date.now()}.png`)
        await guest.page.screenshot({ path: gfile })
        log(`Guest screenshot: ${gfile}`)
      } catch { /* guest page gone */ }
    }
    if (!(result && result.ok)) { const bfile = await driver.shot('live-bot'); if (bfile) log(`Bot screenshot: ${bfile}`) }
    // cleanup: end the test meeting for everyone so nothing keeps running or recording
    let ended = false
    if (guest && guestIsHost) ended = await endMeetingFrom(guest.page)
    if (!ended && driver.page && /\/wc\/\d+\/start/.test(driver.page.url())) ended = await endMeetingFrom(driver.page)
    if (!ended && guest) ended = await endMeetingFrom(guest.page)
    if (driver.started) log(ended ? 'Test meeting ended for everyone.' : 'WARNING: could not end the test meeting automatically. Check Zoom and end it by hand.')
    else log('No meeting was started, so there is nothing to end.')
    try { if (guest) await guest.browser.close() } catch { /* closed */ }
    await driver.close()
    try { fs.rmSync(guestProfile, { recursive: true, force: true }) } catch { /* best effort */ }
  }

  const failed = results.filter((x) => !x).length
  console.log(failed === 0 && results.length ? '\nALL PASSED' : `\n${failed || 'SOME'} FAILED`)
  process.exit(failed === 0 && results.length ? 0 : 1)
})().catch((e) => { console.error('ERR', e.message); process.exit(1) })
