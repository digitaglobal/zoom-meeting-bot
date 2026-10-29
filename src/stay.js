'use strict'
// When the bot cannot finish the hand-over it does NOT drop off: a meeting must not be left without its host. It waits
// here. On your computer you end it with Ctrl+C; on GitHub the run's own time limit ends it (and shows it as failed).
// The run is marked FAILED up front, and if the browser dies while waiting the process exits with code 1: it must never
// finish "green" after a failed hand-over, because the failed run is the only alert there is.
async function stayInMeeting(driver, cfg, log, why) {
  process.exitCode = 1
  const browser = driver && driver.browser
  if (browser && typeof browser.on === 'function') {
    browser.on('disconnected', () => { log('The browser closed while the bot was waiting in the meeting.'); process.exit(1) })
  }
  log(`The bot is staying in the meeting as host. ${why} ${cfg.ci ? 'It stays until this run reaches its time limit.' : 'Press Ctrl+C to close it.'}`)
  await new Promise(() => {})
}

module.exports = { stayInMeeting }
