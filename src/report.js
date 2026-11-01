'use strict'
// A private "what happened" message to the owner's own automation (a secret https address, for example a Pabbly "catch
// webhook"), so that it can keep a permanent log and send an alert.
//
// The address is a secret: it is only read from the environment, never logged, and Chrome never sees it. A report says what
// happened and when. It never carries a login, a link, a meeting number or the new host's name. The meeting TITLE is
// included on purpose (it tells the owner which interview it was): it goes only to that private address, never to the run log.
// A report that cannot be delivered never changes the outcome of the hand-over.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { scrub } = require('./log')

// Written when a report was delivered, so the workflow's "run failed" step does not send a second one for the same run.
// It belongs to ONE run (its id and attempt) and lives in the runner's own temp folder: the tests that run earlier in the same
// job must never be able to switch the real failure alert off.
function markerPath(env = process.env) {
  const part = (v, fallback) => String(v || fallback).replace(/[^\w.-]/g, '')
  return path.join(env.RUNNER_TEMP || os.tmpdir(), `zoom-bot-reported-${part(env.GITHUB_RUN_ID, 'local')}-${part(env.GITHUB_RUN_ATTEMPT, '1')}`)
}

// The only fields a report may hold. A test pins this list, so a new field cannot slip in unnoticed.
const REPORT_FIELDS = ['event', 'ok', 'at', 'when', 'text', 'reason', 'detail', 'interview', 'starts', 'seconds', 'run']

function parseReportUrl(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  let u
  try { u = new URL(text) } catch { return null }
  if (u.protocol !== 'https:' || u.username || u.password) return null
  return u.toString()
}

// Control characters and invisible direction/zero-width characters out, white space collapsed, cut to length.
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
// A field that Slack, a mail, a web page or a spreadsheet might interpret: no angle brackets or ampersands, and no leading
// formula character. (The interview title comes from a booking page that an outsider can type into.)
const plain = (s) => s.replace(/[<>]/g, '').replace(/&/g, 'and').replace(/^[=+\-@]/, "'$&")
const field = (s, max) => plain(clean(s, max)).slice(0, max)
const slackSafe = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// On a local (non-quiet) run the bot's own messages can name the new host. A report never does. `names` is one name or a list
// (the configured name and the name Zoom shows for that person). With `words: false` only the whole name is hidden, not each
// single word of it (used for the interview title, where a candidate may share a surname).
function hideName(text, names, { words = true } = {}) {
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = []
  for (const name of [].concat(names || []).map((n) => String(n || '').trim()).filter(Boolean)) {
    const split = name.split(/\s+/)
    parts.push(split.map(esc).join('\\s+'))
    if (words) parts.push(...split.filter((w) => w.length >= 3).map(esc))
  }
  if (!parts.length) return text
  parts.sort((a, b) => b.length - a.length) // longest first: a full name wins over one of its own words
  return text.replace(new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})(?![\\p{L}\\p{N}])`, 'giu'), 'the new host')
}

// Only a link to this run's page on GitHub is ever put in a report.
function runUrlFromEnv(env = process.env) {
  const url = `${env.GITHUB_SERVER_URL || ''}/${env.GITHUB_REPOSITORY || ''}/actions/runs/${env.GITHUB_RUN_ID || ''}`
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+$/.test(url) ? url : ''
}

function whenText(now, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(now)
}

// event: 'handover' (a meeting was started; ok says whether the host change finished), 'error' (the bot stopped with a
// problem), 'run-failed' (the workflow itself failed) or 'test' (a button in GitHub that checks the report reaches the owner).
function buildReport({ event, ok, reason, detail, meeting, startedAt, hostName, now = new Date(), timeZone = 'America/Jamaica', runUrl = '' }) {
  const out = { event, ok: !!ok, at: now.toISOString(), when: whenText(now, timeZone) }
  const interview = meeting && meeting.title ? field(hideName(clean(scrub(meeting.title), 600), hostName, { words: false }), 120) : ''
  if (interview) out.interview = interview
  if (meeting && meeting.start) out.starts = field(meeting.start, 12)
  if (startedAt) out.seconds = Math.max(0, Math.round((now - startedAt) / 1000))
  if (reason) out.reason = field(hideName(clean(reason, 600), hostName), 60)
  if (detail) out.detail = field(hideName(clean(scrub(detail), 2000), hostName), 200)
  if (runUrl) out.run = runUrl
  const run = runUrl ? ` Details: ${runUrl}` : ''
  const which = interview ? ` "${slackSafe(interview)}"` : ''
  if (event === 'handover' && ok) {
    out.text = `:white_check_mark: Zoom bot: the interview${which} was started and handed to the new host (${out.when}).`
  } else if (event === 'handover') {
    out.text = `:warning: Zoom bot: the interview${which} was started but the hand-over did NOT finish (${out.reason || 'unknown reason'}). The bot is staying in the meeting as host: please check it now.${run}`
  } else if (event === 'error') {
    out.text = `:warning: Zoom bot stopped with a problem: ${slackSafe(out.detail || 'unknown')}. If it is about signing in, the saved login has expired: run \`npm run export-session\` and update the GitHub secret ZOOM_SESSION.${run}`
  } else if (event === 'test') {
    out.text = `:test_tube: Zoom bot test report: if you can read this, reports reach you. No interview was started.${run}`
  } else {
    out.text = `:warning: Zoom bot: a run FAILED, so an interview may not be started. The run page shows why.${run} If the reason is the saved Zoom login (expired, or "not a valid saved session"), fix it in 2 minutes: on your computer run \`npm run export-session\` in the Zoom Meeting Bot folder, then paste the result into the GitHub secret ZOOM_SESSION.`
  }
  return out
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Never throws, never logs the address or the network error text (which can contain the address).
async function sendReport(url, payload, { fetchImpl = fetch, log = () => {}, markerFile = markerPath(), timeoutMs = 10000, tries = 2, sleep = realSleep } = {}) {
  if (!url) return { sent: false, skipped: true }
  let status = 'no answer'
  for (let i = 0; i < tries; i++) {
    if (i > 0) await sleep(1500)
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error', // never hand the report on to another address
        signal: AbortSignal.timeout(timeoutMs),
      })
      status = res.status
      if (res.ok) {
        try { fs.writeFileSync(markerFile, '1') } catch { /* the marker only avoids a duplicate message */ }
        return { sent: true, status }
      }
      if (res.status >= 400 && res.status < 500) break // asking again will not help
    } catch (e) {
      status = e && e.name === 'TimeoutError' ? 'timed out' : 'could not connect'
    }
  }
  log(`The report could not be delivered (${status}). The hand-over itself is not affected.`)
  return { sent: false, status }
}

function alreadyReported(markerFile = markerPath()) {
  try { return fs.existsSync(markerFile) } catch { return false }
}

module.exports = { markerPath, REPORT_FIELDS, parseReportUrl, runUrlFromEnv, buildReport, sendReport, alreadyReported }
