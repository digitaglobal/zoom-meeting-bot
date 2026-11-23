'use strict'
// Reads settings from the environment, the project's ../.env.local and this folder's .env. Existing environment
// variables win. Refuses to start if there is no way to sign in to Zoom. Nothing here ever prints a secret.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { decodeSession } = require('./session')
const { parseReportUrl } = require('./report')
const { API_KEYS, parseApiCredentials } = require('./zoomApi')
const { norm } = require('./participants')
const { loadStaffFile, parseStaffJson, mergeOverrides, emptyOverrides } = require('./staffList')
const { parseSlackIds, mergeExcludeIds, isSlackUserId, DEFAULT_EXCLUDED_SLACK_IDS, DEFAULT_FIRST_HOST_SLACK_ID } = require('./slackRoster')

// Only these settings are ever read from an env file. Anything else in the file (another project's secrets) is ignored,
// so it can never end up in this process or in the browser's environment.
const ALLOWED_KEYS = new Set(['ZOOM_USERNAME', 'ZOOM_PASSWORD', 'ZOOM_SESSION', 'ZOOM_TIMEZONE', 'NEW_HOST_NAME', 'BACKUP_HOST_NAMES', 'SLACK_ROSTER_TOKEN', 'SLACK_ROSTER_EXCLUDE_IDS', 'FIRST_HOST_SLACK_ID', 'STAFF_LIST_PATH', 'STAFF_JSON', 'WAIT_FOR_NEW_HOST_SECONDS', 'MEETING_FILTER', 'LEAD_MINUTES', 'LATE_MINUTES', 'CHROME_PATH', 'HEADED', 'PROFILE_DIR', 'QUIET', 'REPORT_WEBHOOK_URL', ...API_KEYS])

function loadDotEnv(file, env = process.env, allowed = ALLOWED_KEYS) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || line.trim().startsWith('#') || !allowed.has(m[1])) continue
    if (env[m[1]] === undefined) env[m[1]] = m[2].replace(/^"(.*)"$/, '$1')
  }
}

// The Zoom API credentials are read ONLY from this folder's own .env (or the environment), never from the parent app's
// ../.env.local: that file uses some of the same names (ZOOM_ACCOUNT_ID, ZOOM_S2S_*, ZOOM_HOST_EMAIL) for a different Zoom app,
// and the bot must not silently borrow those or fail on a half-matching set.
const PARENT_ALLOWED_KEYS = new Set([...ALLOWED_KEYS].filter((k) => !API_KEYS.includes(k)))

function loadEnvFiles(env = process.env) {
  loadDotEnv(path.join(__dirname, '..', '.env'), env)
  loadDotEnv(path.join(__dirname, '..', '..', '.env.local'), env, PARENT_ALLOWED_KEYS)
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

// BACKUP_HOST_NAMES: people who get host if they show up before the first choice (NEW_HOST_NAME, who always wins a tie).
// Separated by commas, semicolons or new lines. A name is matched as whole words, so on a cloud run (nobody watching) every
// name must be a FULL display name: a single word such as "Mila" would also fit a stranger called "Mila Kunis". Errors say
// which problem it is, never the name (a secret).
const MAX_BACKUPS = 20
function parseBackupNames(raw, firstChoice, ci) {
  const seen = new Set([norm(firstChoice)])
  const names = []
  for (const part of String(raw ?? '').split(/[,;\r\n]+/)) {
    const name = part.trim()
    if (!name) continue
    if (name.length > 100) throw new Error('BACKUP_HOST_NAMES: a name is too long')
    const key = norm(name)
    if (!key) throw new Error('BACKUP_HOST_NAMES: a name has no letters or digits')
    if (ci && key.split(' ').length < 2) throw new Error('BACKUP_HOST_NAMES: on a cloud run every name must be a full display name (first and last), as Zoom shows it')
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  if (names.length > MAX_BACKUPS) throw new Error(`BACKUP_HOST_NAMES: at most ${MAX_BACKUPS} names`)
  return names
}

function loadConfig(env = process.env, opts = {}) {
  const username = String(env.ZOOM_USERNAME ?? '').trim()
  const password = String(env.ZOOM_PASSWORD ?? '')
  const rawSession = String(env.ZOOM_SESSION ?? '').trim()
  // The Zoom API credentials (all six, or none) need no login at all: that is the permanent way in and it wins over a saved session.
  const api = opts.namesOnly ? null : parseApiCredentials(env)
  // Otherwise a saved session is enough on its own (the older cloud way, it expires in ~15 h); otherwise a login is required.
  // namesOnly is for --who-would-host: it never opens Zoom, so a login is not required.
  if (!opts.namesOnly && !rawSession && !api) {
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
  const backupHostNames = parseBackupNames(env.BACKUP_HOST_NAMES, newHostName, ci)
  // Optional overrides only (aliases, priority, extra exclusions). The live Slack roster is the source of truth.
  const staffListPath = String(env.STAFF_LIST_PATH ?? '').trim()
  const staffJsonRaw = String(env.STAFF_JSON ?? '').trim()
  const staffOverrides = mergeOverrides(
    staffJsonRaw ? parseStaffJson(staffJsonRaw) : emptyOverrides(),
    staffListPath ? loadStaffFile(path.resolve(staffListPath)) : emptyOverrides(),
  )
  const filePeople = staffOverrides.people || []
  // Optional: a Slack token with permission "users:read". With it, every active person in Slack (minus exclusions) can be made host.
  const slackRosterToken = String(env.SLACK_ROSTER_TOKEN ?? '').trim()
  if (slackRosterToken && !/^xox[a-z]-[A-Za-z0-9-]{10,300}$/.test(slackRosterToken)) throw new Error('SLACK_ROSTER_TOKEN is not a Slack token (it should start with "xoxb-")')
  const slackRosterExcludeIds = mergeExcludeIds(
    parseSlackIds(env.SLACK_ROSTER_EXCLUDE_IDS, { defaults: DEFAULT_EXCLUDED_SLACK_IDS, setting: 'SLACK_ROSTER_EXCLUDE_IDS' }),
    staffOverrides.excludeIds,
  )
  const firstHostSlackId = String(env.FIRST_HOST_SLACK_ID || staffOverrides.firstHostSlackId || DEFAULT_FIRST_HOST_SLACK_ID).trim()
  if (firstHostSlackId && !isSlackUserId(firstHostSlackId)) throw new Error('FIRST_HOST_SLACK_ID is not a Slack user id')

  let meetingFilter = null
  const filterText = String(env.MEETING_FILTER ?? '.*').trim()
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
    // In API mode an old saved login is ignored entirely: it is not decoded and never handed to Chrome as cookies.
    session: (!opts.namesOnly && rawSession && !api) ? decodeSession(rawSession) : null,
    api, // { accountId, clientId, clientSecret, sdkKey, sdkSecret, hostEmail } or null. Secrets: never print this object.
    newHostName,
    backupHostNames, // other people who get host if they are seen before the first choice (newHostName); never printed
    filePeople, // fail-safe people from STAFF_JSON / STAFF_LIST_PATH. Never printed.
    staffOverrides, // aliases, priority, exclusions. Never printed in full if it holds names.
    staffListPath, // may be empty. A path, not a secret, but still never handed to Chrome.
    staffJson: staffJsonRaw, // may be empty. A secret-like setting: never print it.
    slackRosterToken, // '' = off. A secret: never print this object.
    slackRosterExcludeIds, // Slack user ids skipped on the roster (defaults include Front Desk and Casey).
    firstHostSlackId, // default Jordan Banks's Slack id; used when the live roster is on.
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

module.exports = { loadDotEnv, loadEnvFiles, loadConfig, findChrome, CHROME_CANDIDATES, ALLOWED_KEYS, PARENT_ALLOWED_KEYS }
