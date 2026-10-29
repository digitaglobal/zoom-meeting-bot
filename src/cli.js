#!/usr/bin/env node
'use strict'
// Usage:
//   node src/cli.js                  start a NEW meeting, wait for Kemal, make him host, drop off
//   node src/cli.js --meeting 123456789   start that SCHEDULED meeting instead
//   node src/cli.js --tick           schedule check: if a meeting is about to start, start it and hand over
//   node src/cli.js --tick --dry-run     only say what would happen
//   node src/cli.js --name "Maria"   hand host to someone else
//   node src/cli.js --wait 900       wait up to 15 minutes for the new host
//   node src/cli.js --hidden / --headed  run the browser without / with a window
const { loadEnvFiles, loadConfig } = require('./config')
const { ZoomBrowserDriver } = require('./browserDriver')
const { runHandover } = require('./handover')
const { runTick } = require('./tick')
const { makeLog, scrub } = require('./log')
const { stayInMeeting } = require('./stay')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--name') out.name = argv[++i]
    else if (a === '--wait') out.wait = argv[++i]
    else if (a === '--meeting') out.meeting = argv[++i]
    else if (a === '--tick') out.tick = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--hidden') out.headed = false
    else if (a === '--headed') out.headed = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`Unknown option: ${a}`)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log('See the header of src/cli.js, or the README.'); return 0 }
  loadEnvFiles()
  const cfg = loadConfig()
  if (args.name) cfg.newHostName = args.name
  if (args.wait) cfg.waitSeconds = Number(args.wait)
  if (args.headed !== undefined) cfg.headed = args.headed
  if (!Number.isFinite(cfg.waitSeconds) || cfg.waitSeconds < 10) throw new Error('--wait must be at least 10 seconds')
  if (args.meeting && !/^\d{9,11}$/.test(args.meeting)) throw new Error('--meeting must be a 9 to 11 digit Zoom meeting number')
  if (args.dryRun && !args.tick) throw new Error('--dry-run only works together with --tick')

  const log = makeLog({ quiet: cfg.quiet, timeZone: cfg.timeZone })
  const driver = new ZoomBrowserDriver(cfg, log)
  process.on('SIGINT', async () => { log('Closing the browser...'); await driver.close(); process.exit(130) })

  let result
  try {
    if (args.tick) {
      result = await runTick(driver, cfg, { dryRun: args.dryRun }, { log })
      if (result.action !== 'handover') { await driver.close(); return 0 }
    } else {
      result = await runHandover(driver, {
        newHostName: cfg.newHostName,
        waitMs: cfg.waitSeconds * 1000,
        start: args.meeting ? { meetingId: args.meeting } : undefined,
        redactNames: cfg.quiet,
        onStarted: (info) => {
          if (cfg.quiet) return // never print the invite link where it could be public
          console.log('\n==============================================================')
          console.log(` Send this link to ${cfg.newHostName} so they can join:`)
          console.log(`   ${info.link}`)
          console.log('==============================================================\n')
        },
      }, { log })
    }
  } catch (e) {
    log(`Problem: ${e.message}`)
    const file = await driver.shot('error')
    if (file) log(`Screenshot: ${file}`)
    if (driver.started) return stayInMeeting(driver, cfg, log, 'An error happened after the meeting started.')
    await driver.close()
    return 1
  }

  if (result.ok) {
    log(`Done. ${cfg.quiet ? 'The new host' : result.target.userName} is the host and the bot has left.`)
    await driver.close()
    return 0
  }
  log(`Not finished: ${result.detail}`)
  return stayInMeeting(driver, cfg, log, result.detail)
}

// Anything that escapes is printed through the same mask as the log (a public run's output is public).
const fatal = (e) => { console.error(`Error: ${scrub((e && e.message) || e)}`); process.exit(1) }
process.on('unhandledRejection', fatal)
process.on('uncaughtException', fatal)

main().then((code) => process.exit(code), fatal)
