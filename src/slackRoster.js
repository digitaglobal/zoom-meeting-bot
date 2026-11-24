'use strict'
// The live list of people who work here, read from the Slack workspace on every run, so someone who leaves
// (deactivated in Slack) drops off and someone who joins is added without editing a staff file.
// Required permission: "users:read". The token and the names never reach a log or an error message:
// errors carry only Slack's own error code.
const fs = require('fs')
const { norm, tokens } = require('./participants')

const MAX_PAGES = 10 // 200 members per page
const MAX_NAME = 100

// Nobody is skipped and nobody is first by id until the SETTINGS say so: no real id is built into this (public) code.
// SLACK_ROSTER_EXCLUDE_IDS = comma-separated Slack user ids to skip (shared or test accounts, not people). Compared case-insensitively.
const DEFAULT_EXCLUDED_SLACK_IDS = Object.freeze([])
// FIRST_HOST_SLACK_ID = the Slack user id of the person who is first in line for host when the live roster is on. When it is empty the
// person named in NEW_HOST_NAME is first, matched by name.
const DEFAULT_FIRST_HOST_SLACK_ID = ''

const SLACK_ID = /^U[A-Z0-9]{8,11}$/i
const isSlackUserId = (s) => SLACK_ID.test(String(s ?? '').trim())
const idKey = (s) => String(s ?? '').trim().toUpperCase()

function parseSlackIds(raw, { defaults = [], setting = 'SLACK_ROSTER_EXCLUDE_IDS' } = {}) {
  const parts = String(raw ?? '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean)
  if (!parts.length) return [...defaults]
  const out = []
  const seen = new Set()
  for (const part of parts) {
    if (!isSlackUserId(part)) throw new Error(`${setting} has an entry that is not a Slack user id`)
    const key = idKey(part)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(part.trim())
  }
  return out
}

function mergeExcludeIds(...lists) {
  const out = []
  const seen = new Set()
  for (const list of lists) {
    for (const id of list || []) {
      if (!isSlackUserId(id)) continue
      const key = idKey(id)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(id)
    }
  }
  return out
}

// A real person: not deactivated, not a bot or app, not Slackbot, and not a guest (guests are outside accounts).
function isActivePerson(u) {
  return !!u && !u.deleted && !u.is_bot && !u.is_app_user && u.id !== 'USLACKBOT' && !u.is_restricted && !u.is_ultra_restricted
}

function isExcludedId(id, excludeIds) {
  const key = idKey(id)
  return (excludeIds || []).some((x) => idKey(x) === key)
}

// A usable official name has at least TWO words after punctuation is normalized, one of them a real word (two or more letters or
// digits): first name plus at least a last initial. "Jordan Banks", "Avery S" and "Sasha.t" (which becomes "sasha t") all count.
// A one-word name ("Jordan", "Casey") does not: a bare first name is never matched (a stranger could simply type it), so such a
// member is left off the list instead of being given a name nobody can safely be matched by.
function usableName(name) {
  const text = String(name ?? '').trim()
  if (!text || text.length > MAX_NAME) return false
  const words = tokens(text)
  return words.length >= 2 && words.some((w) => w.length >= 2)
}

function pickOfficialName(u) {
  const p = (u && u.profile) || {}
  const candidates = [u && u.real_name, p.real_name, p.display_name].map((n) => String(n ?? '').trim()).filter(usableName)
  if (!candidates.length) return ''
  // Prefer the form with more tokens after normalization, so "Jordan Banks" wins over display "Jordan",
  // and "Sasha.t" (two tokens) wins over display "Sasha".
  candidates.sort((a, b) => {
    const dt = tokens(b).length - tokens(a).length
    if (dt) return dt
    return b.length - a.length
  })
  return candidates[0]
}

function titleWord(word) {
  const w = String(word ?? '')
  if (!w) return w
  return w.charAt(0).toUpperCase() + w.slice(1)
}

// "Jordan Banks" and "Sasha.t" both produce "Jordan B" / "Jordan B." or "Sasha T" / "Sasha T.".
function firstInitialForms(name) {
  const t = tokens(name)
  if (t.length < 2) return []
  const first = titleWord(t[0])
  const initial = t[t.length - 1].charAt(0).toUpperCase()
  if (!first || !initial) return []
  return [`${first} ${initial}`, `${first} ${initial}.`]
}

function addAlias(entry, alias) {
  const text = String(alias ?? '').trim()
  if (!text || text.length > MAX_NAME || !norm(text)) return
  const key = norm(text)
  if (key === norm(entry.name)) return
  if ((entry.aliases || []).some((a) => norm(a) === key)) return
  entry.aliases.push(text)
}

// Every alias has at least two words: first name plus last initial ("Jordan B", "Jordan B."), and the Slack display name when it
// has two or more words. A one-word display name ("Jordan") and the bare first name are NOT added, even when nobody else shares
// that first name: a stranger could simply type it (the matcher also ignores one-word aliases for a multi-word name).
function attachDerivedAliases(members) {
  for (const m of members) {
    for (const form of firstInitialForms(m.name)) addAlias(m, form)
    const display = String(m.displayName ?? '').trim()
    if (display && tokens(display).length >= 2) addAlias(m, display)
  }
  return members
}

function memberFromUser(u) {
  const name = pickOfficialName(u)
  if (!name) return null
  const displayName = String((u.profile || {}).display_name ?? '').trim()
  return { slackId: String(u.id || '').trim(), name, displayName, aliases: [] }
}

const safeCode = (c) => (/^[a-z_]{1,40}$/.test(String(c ?? '')) ? c : 'unknown')

// -> [{ slackId, name, displayName, aliases }]. Throws a short, secret-free error if Slack says no.
async function fetchActiveMembers(token, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch
  const excludeIds = deps.excludeIds || DEFAULT_EXCLUDED_SLACK_IDS
  const members = []
  const seenIds = new Set()
  let cursor = ''
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = new URLSearchParams({ limit: '200' })
    if (cursor) q.set('cursor', cursor)
    let body
    try {
      const res = await doFetch(`https://slack.com/api/users.list?${q}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10000) })
      body = await res.json()
    } catch {
      throw new Error('Slack could not be reached')
    }
    if (!body || body.ok !== true) throw new Error(`Slack refused the member list (${safeCode(body && body.error)})`)
    for (const u of body.members || []) {
      if (!isActivePerson(u)) continue
      if (isExcludedId(u.id, excludeIds)) continue
      const member = memberFromUser(u)
      if (!member || !member.slackId) continue
      const key = idKey(member.slackId)
      if (seenIds.has(key)) continue
      seenIds.add(key)
      members.push(member)
    }
    cursor = body.response_metadata && body.response_metadata.next_cursor
    if (!cursor) return attachDerivedAliases(members)
  }
  throw new Error('The Slack member list is longer than the bot reads')
}

// Older helper: official names only, no aliases. Kept for anything that still expects a string list.
async function fetchActiveNames(token, deps = {}) {
  return (await fetchActiveMembers(token, deps)).map((m) => m.name)
}

// One Slack call per run, reused if the hand-over asks again. A failed call is not cached, so a later
// refresh can try again. Fail-safe (NEW_HOST_NAME / BACKUP_HOST_NAMES) is applied by the caller.
function createRosterFetcher(token, deps = {}) {
  let cached = null
  let inflight = null
  const get = async () => {
    if (cached) return cached
    if (inflight) return inflight
    const pending = fetchActiveMembers(token, deps)
      .then((rows) => { cached = rows; return rows })
      .finally(() => { inflight = null })
    inflight = pending
    return pending
  }
  get.clear = () => { cached = null }
  return get
}


// A local JSON fixture for offline --who-would-host checks. Accepts an array of
// { slackId, name, displayName, aliases } or { slackId, real_name, profile: { display_name } }.
function loadRosterFixture(filePath, deps = {}) {
  if (!filePath) throw new Error('A roster fixture path is required')
  if (!fs.existsSync(filePath)) throw new Error('The roster fixture does not exist')
  let data
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { throw new Error('The roster fixture is not valid JSON') }
  const rows = Array.isArray(data) ? data : (data.members || data.people || [])
  if (!Array.isArray(rows)) throw new Error('The roster fixture must be a list of people')
  const excludeIds = deps.excludeIds || DEFAULT_EXCLUDED_SLACK_IDS
  const members = []
  for (const row of rows) {
    if (!row) continue
    const id = row.slackId || row.id || ''
    if (isExcludedId(id, excludeIds)) continue
    if (row.name) {
      if (!usableName(row.name)) continue // a one-word name can never be matched safely (see usableName)
      members.push({ slackId: String(id).trim(), name: String(row.name).trim(), displayName: String(row.displayName || (row.profile && row.profile.display_name) || '').trim(), aliases: [...(row.aliases || [])] })
    } else {
      const member = memberFromUser({ id, real_name: row.real_name || row.realName, profile: row.profile || { real_name: row.real_name, display_name: row.display_name || row.displayName } })
      if (member) members.push(member)
    }
  }
  return attachDerivedAliases(members)
}

module.exports = {
  DEFAULT_EXCLUDED_SLACK_IDS,
  DEFAULT_FIRST_HOST_SLACK_ID,
  isSlackUserId,
  parseSlackIds,
  mergeExcludeIds,
  isActivePerson,
  isExcludedId,
  usableName,
  pickOfficialName,
  firstInitialForms,
  attachDerivedAliases,
  fetchActiveMembers,
  fetchActiveNames,
  createRosterFetcher,
  loadRosterFixture,
}
