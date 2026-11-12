'use strict'
// The live list of people who work here: the names of the active members of the Slack workspace, read fresh on every run, so
// someone who leaves (deactivated in Slack) drops off and someone who joins is added without touching any setting.
// Needs a Slack token with the single permission "users:read" (a read-only app of its own, not the Paula bot's token).
// The token and the names never reach a log or an error message: errors carry only Slack's own error code.
const { norm } = require('./participants')

const MAX_PAGES = 10 // 200 members per page
const MAX_NAME = 100

// A real person: not deactivated, not a bot or app, not Slackbot, and not a guest (guests are outside accounts).
function isActivePerson(u) {
  return !!u && !u.deleted && !u.is_bot && !u.is_app_user && u.id !== 'USLACKBOT' && !u.is_restricted && !u.is_ultra_restricted
}

// "Jamie Sample" is usable; "Jamie" (one word) and "Alex S" (an initial) are not: matched as whole words they would also
// fit strangers, or never fit the name Zoom shows.
function usableName(name) {
  const text = String(name ?? '').trim()
  if (!text || text.length > MAX_NAME) return false
  const words = norm(text).split(' ').filter(Boolean)
  return words.length >= 2 && words.every((w) => w.length >= 2)
}

const safeCode = (c) => (/^[a-z_]{1,40}$/.test(String(c ?? '')) ? c : 'unknown')

// -> ["Jamie Sample", ...] (full names of the active people, no repeats). Throws a short, secret-free error if Slack says no.
async function fetchActiveNames(token, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch
  const names = []
  const seen = new Set()
  const add = (n) => {
    if (!usableName(n)) return
    const key = norm(n)
    if (seen.has(key)) return
    seen.add(key)
    names.push(String(n).trim())
  }
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
      const p = u.profile || {}
      add(u.real_name)
      add(p.real_name)
      add(p.display_name)
    }
    cursor = body.response_metadata && body.response_metadata.next_cursor
    if (!cursor) return names
  }
  throw new Error('The Slack member list is longer than the bot reads')
}

module.exports = { fetchActiveNames, isActivePerson, usableName }
