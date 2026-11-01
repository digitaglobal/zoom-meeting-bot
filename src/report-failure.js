'use strict'
// Run by the workflow only when a step failed (and not for the backup schedule). Sends one private "the run failed" report,
// unless the bot already sent a report during THIS run. It always ends normally: telling the owner must never be a second failure.
const { parseReportUrl, runUrlFromEnv, buildReport, sendReport, alreadyReported, markerPath } = require('./report')

async function main(env = process.env, deps = {}) {
  const url = parseReportUrl(env.REPORT_WEBHOOK_URL)
  if (!url) { console.log('No report address is set, so there is nothing to send.'); return { sent: false } }
  const markerFile = deps.markerFile || markerPath(env)
  if (alreadyReported(markerFile)) { console.log('The bot already reported this run.'); return { sent: false, already: true } }
  const result = await sendReport(url, buildReport({ event: 'run-failed', ok: false, runUrl: runUrlFromEnv(env) }), { log: console.log, ...deps, markerFile })
  console.log(result.sent ? 'Failure report sent.' : 'Failure report not sent.')
  return result
}

if (require.main === module) main().then(() => process.exit(0), () => process.exit(0))

module.exports = { main }
