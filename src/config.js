'use strict'
// Reads settings from the environment, the project's ../.env.local and this folder's .env. Existing environment
// variables win. Refuses to start if there is no way to sign in to Zoom. Nothing here ever prints a secret.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { decodeSession } = require('./session')
const { parseReportUrl } = require('./report')

// Only these settings are ever read from an env file. Anything else in the file (another project's secrets) is ignored,
// so it can never end up in this process or in the browser's environment.
const ALLOWED_KEYS = new Set(['ZOOM_USERNAME', 'ZOOM_PASSWORD', 'ZOOM_SESSION', 'ZOOM_TIMEZONE', 'NEW_HOST_NAME', 'WAIT_FOR_NEW_HOST_SECONDS', 'MEETING_FILTER', 'LEAD_MINUTES', 'LATE_MINUTES', 'CHROME_PATH', 'HEADED', 'PROFILE_DIR', 'QUIET', 'REPORT_WEBHOOK_URL'])

function loadDotEnv(file, env = process.env) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#') || !ALLOWED_KEYS.has(m[1])) continue
    if (env[m[1]] === undefined) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1')
  }
}

function loadEnvFiles(env = process.env) {
  loadDotEnv(path.join(__dirname, '..', '.env'), env)
  loadDotEnv(path.join(__dirname, '..', '..', '.env.local'), env)
}

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]

function findChrome(explicit, exists = fs.existsSync) {
  if (explicit) {
    if (!exists(explicit)) throw new Error(`CHROME_PATH does not exist: ${explicit}`)
    return explicit
  }
  const found = CHROME_CANDIDATES.find((p) => exists(p))
  if (!found) throw new Error('Could not find Chrome or Edge. Install Chrome, or set CHROME_PATH.')
  return found
}

const truthy = (v) => v === '1' || /^true$/i.test(String(v ?? ''))

function whole(env, key, fallback, min, max) {
  const n = Number(env[key] === undefined || env[key] === '' ? fallback : env[key])
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${key} must be a number from ${min} to ${max}`)
  return n
}

function loadConfig(env = process.env) {
  const username = String(env.ZOOM_USERNAME ?? '').trim()
  const password = String(env.ZOOM_PASSWORD ?? '')
  const rawSession = String(env.ZOOM_SESSION ?? '').trim()
  // A saved session is enough on its own (that is how the cloud run works); otherwise a login is required.
  if (!rawSession) {
    const missing = [!username && 'ZOOM_USERNAME', !password.trim() && 'ZOOM_PASSWORD'].filter(Boolean)
    if (missing.length) throw new Error(`Missing settings: ${missing.join(', ')} (put them in a .env file; see .env.example)`)
  }
  const waitSeconds = Number(env.WAIT_FOR_NEW_HOST_SECONDS || 1800)
  if (!Number.isFinite(waitSeconds) || waitSeconds < 10) throw new Error('WAIT_FOR_NEW_HOST_SECONDS must be a number of at least 10')
  const ci = truthy(env.CI) || truthy(env.GITHUB_ACTIONS)
  // On a cloud run nobody is watching, so the host's FULL display name must be given: a first name alone lets lookalikes fit.
  if (ci && !String(env.NEW_HOST_NAME ?? '').trim()) throw new Error('NEW_HOST_NAME must be set on a cloud run: the host\'s full display name, as Zoom shows it (use a GitHub secret).')
  const newHostName = String(env.NEW_HOST_NAME || 'Kemal').trim()
  if (!newHostName) throw new Error('NEW_HOST_NAME cannot be empty')

  let meetingFilter = null
  const filterText = String(env.MEETING_FILTER ?? 'interview').trim()
  if (filterText && filterText !== '.*') {
    if (filterText.length > 100) throw new Error('MEETING_FILTER is too long')
    try { meetingFilter = new RegExp(filterText, 'i') } catch { throw new Error('MEETING_FILTER is not a valid pattern') }
  }

  const timeZone = String(env.ZOOM_TIMEZONE || 'America/Jamaica').trim()
  try { new Intl.DateTimeFormat('en-US', { timeZone }) } catch { throw new Error('ZOOM_TIMEZONE is not a valid time zone name') }

  return {
    username,
    password,
    canSignInWithPassword: !!(username && password.trim()),
    session: rawSession ? decodeSession(rawSession) : null,
    newHostName,
    waitSeconds,
    chromePath: (env.CHROME_PATH || '').trim(),
    headed: env.HEADED === undefined ? false : truthy(env.HEADED),
    // On a cloud run nothing is kept between runs and nothing sensitive is written to disk or to the log.
    ci,
    quiet: ci || truthy(env.QUIET),
    profileDir: env.PROFILE_DIR ? path.resolve(env.PROFILE_DIR) : ci ? path.join(os.tmpdir(), 'zoom-bot-profile') : path.join(__dirname, '..', '.profile'),
    screenshotDir: path.join(__dirname, '..', 'screenshots'),
    // the schedule check ("npm run tick")
    meetingFilter, // only meetings whose title matches; MEETING_FILTER=.* means every meeting
    leadMinutes: whole(env, 'LEAD_MINUTES', 10, 0, 60),
    lateMinutes: whole(env, 'LATE_MINUTES', 5, 0, 120),
    timeZone,
    // the private "what happened" report (see report.js). The address is a secret: it is never printed or logged.
    reportUrl: parseReportUrl(env.REPORT_WEBHOOK_URL),
    reportAddressProblem: !!String(env.REPORT_WEBHOOK_URL ?? '').trim() && !parseReportUrl(env.REPORT_WEBHOOK_URL),
  }
}

module.exports = { loadDotEnv, loadEnvFiles, loadConfig, findChrome, CHROME_CANDIDATES, ALLOWED_KEYS }
