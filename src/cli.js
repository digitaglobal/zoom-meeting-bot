#!/usr/bin/env node
'use strict'
// Usage:
//   node src/cli.js                  start a NEW meeting, wait for Kemal, make him host, drop off
//   node src/cli.js --meeting 123456789   start that SCHEDULED meeting instead
//   node src/cli.js --tick           schedule check: if a meeting is about to start, start it and hand over
//   node src/cli.js --tick --dry-run     only say whether a meeting is due (starts nothing)
//   node src/cli.js --who-would-host --roster test/unit/fixtures/sample-roster.json --people "Jordan B., Jane Guest"
//   node src/cli.js --dry-handover      join a meeting and log who would get host, but never click Admit or Make Host
//   node src/cli.js --test-report    send one test report to REPORT_WEBHOOK_URL and stop (does not open Zoom)
//   node src/cli.js --name "Maria"   hand host to someone else
//   node src/cli.js --wait 900       wait up to 15 minutes for the new host
//   node src/cli.js --hidden / --headed  run the browser without / with a window
const { loadEnvFiles, loadConfig } = require('./config')
const { ZoomBrowserDriver } = require('./browserDriver')
const { ZoomSdkDriver } = require('./sdkDriver')
const { createRosterFetcher, loadRosterFixture } = require('./slackRoster')
const { createZoomApi } = require('./zoomApi')
const { runHandover } = require('./handover')
const { runTick } = require('./tick')
const { makeLog, scrub } = require('./log')
const { stayInMeeting } = require('./stay')
const { buildReport, sendReport, runUrlFromEnv } = require('./report')
const { mergeStaff } = require('./staffList')
const { pickFromPanel, toStaffEntries, admissibleStaff, describeAdmission } = require('./participants')

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--name') out.name = argv[++i]
    else if (a === '--wait') out.wait = argv[++i]
    else if (a === '--meeting') out.meeting = argv[++i]
    else if (a === '--tick') out.tick = true
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--dry-handover') out.dryHandover = true
    else if (a === '--who-would-host') out.whoWouldHost = true
    else if (a === '--people') out.people = argv[++i]
    else if (a === '--roster') out.roster = argv[++i]
    else if (a === '--test-report') out.testReport = true
    else if (a === '--hidden') out.headed = false
    else if (a === '--headed') out.headed = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`Unknown option: ${a}`)
  }
  return out
}

// On GitHub, a value printed as "::add-mask::value" is hidden from then on. Used for the secrets made DURING the run (the registered
// secrets are masked already). Only ever done on GitHub, so a local run never echoes a secret.
function maskInGithubLog(value) {
  if (process.env.GITHUB_ACTIONS && /^[!-~]+$/.test(value)) console.log(`::add-mask::${value}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) { console.log('See the header of src/cli.js, or the README.'); return 0 }
  loadEnvFiles()
  const cfg = loadConfig(process.env, args.whoWouldHost ? { namesOnly: true } : {})
  if (args.name) cfg.newHostName = args.name
  if (args.wait) cfg.waitSeconds = Number(args.wait)
  if (args.headed !== undefined) cfg.headed = args.headed
  if (!Number.isFinite(cfg.waitSeconds) || cfg.waitSeconds < 10) throw new Error('--wait must be at least 10 seconds')
  if (args.meeting && !/^\d{9,11}$/.test(args.meeting)) throw new Error('--meeting must be a 9 to 11 digit Zoom meeting number')
  if (args.dryRun && !args.tick) throw new Error('--dry-run only works together with --tick')
  if (args.dryHandover && args.dryRun) throw new Error('--dry-handover cannot be combined with --tick --dry-run (that dry run never joins a meeting)')

  const log = makeLog({ quiet: cfg.quiet, timeZone: cfg.timeZone })
  const staffEntries = mergeStaff({ newHostName: cfg.newHostName, backupHostNames: cfg.backupHostNames, overrides: cfg.staffOverrides, firstHostSlackId: cfg.firstHostSlackId })
  // With the Zoom API credentials there is no login to expire: meetings come from the API and start through the SDK.
  const driver = cfg.api ? new ZoomSdkDriver(cfg, createZoomApi(cfg.api, { onSecret: maskInGithubLog }), log) : new ZoomBrowserDriver(cfg, log)
  if (cfg.api) log('Using the Zoom API credentials (no Zoom login needed).')
  if (cfg.reportAddressProblem) log('REPORT_WEBHOOK_URL is set but is not a valid https address, so no reports will be sent.')
  // Everyone currently active in Slack may be made host (one fetch per run, minus the exclusion list).
  const getRosterNames = cfg.slackRosterToken ? createRosterFetcher(cfg.slackRosterToken, { excludeIds: cfg.slackRosterExcludeIds }) : undefined
  if (getRosterNames) log('The Slack member list is on: every active member can be made host (the first host first, then the rest).')
  if (cfg.admitAllStaffUnclear) log('ADMIT_ALL_STAFF is set to something other than true or false, so it is OFF.')
  if (cfg.admitAllStaff) log(getRosterNames ? 'ADMIT_ALL_STAFF is on: while the bot is host, every staff member in the waiting room is let in, not only the new host.' : 'ADMIT_ALL_STAFF is on, but the Slack member list is off, so only the fixed host names are let in.')
  if (args.whoWouldHost) {
    const names = String(args.people ?? '').split(/[,\r\n]+/).map((s) => s.trim()).filter(Boolean)
    if (!names.length) throw new Error('--who-would-host needs --people with one or more Zoom display names, separated by commas')
    let entries = staffEntries
    try {
      if (args.roster) {
        const rosterMembers = loadRosterFixture(require('path').resolve(args.roster), { excludeIds: cfg.slackRosterExcludeIds })
        entries = mergeStaff({ newHostName: cfg.newHostName, backupHostNames: cfg.backupHostNames, overrides: cfg.staffOverrides, rosterMembers, firstHostSlackId: cfg.firstHostSlackId })
      } else if (getRosterNames) {
        const rosterMembers = await getRosterNames()
        entries = mergeStaff({ newHostName: cfg.newHostName, backupHostNames: cfg.backupHostNames, overrides: cfg.staffOverrides, rosterMembers, firstHostSlackId: cfg.firstHostSlackId })
      }
    } catch (e) { log(`Could not read the Slack member list (${e && e.message ? e.message : 'unknown problem'}); using the names it already has.`) }
    const people = names.map((userName, i) => ({ userId: `${userName}#${i + 1}`, userName, isMe: false, isHost: false, waiting: false }))
    const picked = pickFromPanel({ inside: people, outside: [], entries })
    // With ADMIT_ALL_STAFF on, also say who would be let in if these names were all waiting in the waiting room.
    if (cfg.admitAllStaff) log(describeAdmission(admissibleStaff({ people: people.map((p) => ({ ...p, waiting: true })), entries, excludeSlackIds: cfg.slackRosterExcludeIds }), { redact: cfg.quiet }))
    if (picked.match) {
      log(`Would make ${cfg.quiet ? 'the new host' : picked.match.userName} the host (matched as ${picked.kind}${picked.usedBackup ? ', backup' : ''}). Nothing was started.`)
      return 0
    }
    if (picked.ambiguous.length) {
      log(`Would not make anyone host: more than one person fits (${cfg.quiet ? picked.ambiguous.length + ' people' : picked.ambiguous.map((a) => a.userName).join(', ')}). Nothing was started.`)
      return 2
    }
    log('Would not make anyone host: no staff member matched those display names. Nothing was started.')
    return 2
  }
  const startedAt = new Date()
  // A private report (see report.js). The backup schedule stays quiet about plain errors, so a dead login is not announced
  // every 10 minutes (the hourly login check announces it); a meeting that was started is always reported.
  const fromBackupSchedule = process.env.GITHUB_EVENT_NAME === 'schedule'
  // Telling the owner must never stop or crash a hand-over (the bot may be in a live meeting), so nothing here can throw.
  const tell = async (event, fields) => {
    try { return await sendReport(cfg.reportUrl, buildReport({ event, startedAt, timeZone: cfg.timeZone, hostName: [cfg.newHostName, ...cfg.backupHostNames], runUrl: runUrlFromEnv(), ...fields }), { log }) } catch { log('The report could not be prepared. The hand-over itself is not affected.'); return { sent: false } }
  }
  if (args.testReport) {
    if (!cfg.reportUrl) { log('There is no valid REPORT_WEBHOOK_URL, so there is nothing to test.'); return 1 }
    const test = await tell('test', { ok: true, reason: 'test', detail: 'No interview was started.', meeting: { title: 'TEST - not a real interview', start: 'none' } })
    log(test.sent ? 'The test report was sent.' : 'The test report was NOT delivered.')
    return test.sent ? 0 : 1
  }
  process.on('SIGINT', async () => { log('Closing the browser...'); await driver.close(); process.exit(130) })

  let result
  try {
    if (args.tick) {
      // The dry run is the hourly login check: with API credentials it proves every permission (sign in, list, host start key).
      if (args.dryRun && driver.verify) { const v = await driver.verify(); log(`The Zoom API credentials work (${cfg.quiet ? 'meetings listed' : v.meetings + ' upcoming meeting(s)'}, host start key issued).`) }
      result = await runTick(driver, cfg, { dryRun: args.dryRun, dryHandover: args.dryHandover, getRosterNames, staffEntries, staffOverrides: cfg.staffOverrides, firstHostSlackId: cfg.firstHostSlackId, admitAllStaff: cfg.admitAllStaff, excludeIds: cfg.slackRosterExcludeIds }, { log })
      if (result.action !== 'handover') { await driver.close(); return 0 }
    } else {
      result = await runHandover(driver, {
        newHostName: cfg.newHostName,
        backupHostNames: cfg.backupHostNames,
        staffEntries,
        staffOverrides: cfg.staffOverrides,
        firstHostSlackId: cfg.firstHostSlackId,
        getRosterNames,
        admitAllStaff: cfg.admitAllStaff,
        excludeIds: cfg.slackRosterExcludeIds,
        waitMs: cfg.waitSeconds * 1000,
        start: args.meeting ? { meetingId: args.meeting } : undefined,
        redactNames: cfg.quiet,
        dryHandover: !!args.dryHandover,
        onStarted: (info) => {
          if (cfg.quiet) return // never print the invite link where it could be public
          console.log('\n==============================================================')
          console.log(` Send this link to ${[cfg.newHostName, ...cfg.backupHostNames].join(' or ')} so they can join:`)
          console.log(`   ${info.link}`)
          console.log('==============================================================\n')
        },
      }, { log })
    }
  } catch (e) {
    log(`Problem: ${e.message}`)
    if (driver.started || !fromBackupSchedule) await tell('error', { ok: false, detail: e.message })
    const file = await driver.shot('error')
    if (file) log(`Screenshot: ${file}`)
    if (driver.started) return stayInMeeting(driver, cfg, log, 'An error happened after the meeting started.')
    await driver.close()
    return 1
  }

  await tell('handover', { ok: result.ok, reason: result.reason, detail: result.detail, meeting: result.meeting, hostName: [cfg.newHostName, ...cfg.backupHostNames, result.target && result.target.userName] })

  if (result.ok && result.dryRun) {
    log('Dry run finished. The bot did not click Admit or Make Host, so it is still the host. Leaving the browser open until you stop it.')
    return stayInMeeting(driver, cfg, log, 'Dry run: no host change was made.')
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
