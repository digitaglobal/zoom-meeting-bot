'use strict'
// One schedule check ("npm run tick"): look at today's Zoom meetings and, if one is about to start, start it as
// host, hand host to the new host and drop off. Meant to run every 10 minutes. If nothing is due it does nothing.
// Which meeting is due is decided by upcoming.js (Jamaica time, "Start" button present, title matches the filter).
const { dueMeetings, clockText } = require('./upcoming')
const { runHandover } = require('./handover')

async function runTick(driver, cfg, opts = {}, deps = {}) {
  const log = deps.log || (() => {})
  const now = (deps.now || (() => new Date()))()
  const handover = deps.runHandover || runHandover

  const meetings = await driver.listUpcoming()
  const due = dueMeetings(meetings, now, {
    timeZone: cfg.timeZone,
    leadMinutes: cfg.leadMinutes,
    lateMinutes: cfg.lateMinutes,
    filter: cfg.meetingFilter,
  })
  // Meeting titles are people's names and never go in the log. A public (quiet) log does not even say how many meetings
  // there are or when they start; a local one does.
  const checked = `Checked Zoom at ${clockText(now, cfg.timeZone)} (${cfg.timeZone})`
  if (cfg.quiet) log(due.length ? `${checked}: a meeting is due.` : `${checked}: nothing due.`)
  else log(`${checked}: ${meetings.length} meeting(s) today, ${due.length} due to start.`)
  if (!due.length) return { ok: true, action: 'nothing-due' }
  if (due.length > 1 && !cfg.quiet) log(`${due.length - 1} more meeting(s) are also due; they are picked up by the next run.`)
  if (opts.dryRun) return { ok: true, action: 'dry-run', due }

  const meeting = due[0]
  if (!cfg.quiet) log(`Starting the meeting that begins at ${meeting.start} (in ${Math.round(meeting.startsInMinutes)} min).`)
  const result = await handover(driver, {
    newHostName: cfg.newHostName,
    backupHostNames: cfg.backupHostNames,
    waitMs: cfg.waitSeconds * 1000,
    start: { meetingId: meeting.id },
    redactNames: cfg.quiet,
  }, { log })
  return { ...result, action: 'handover', meeting }
}

module.exports = { runTick }
