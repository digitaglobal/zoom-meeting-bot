'use strict'
// Optional overrides only: aliases, priority order, and extra Slack exclusion ids.
// The live Slack roster is the source of truth for who is staff. When Slack cannot be read,
// NEW_HOST_NAME and BACKUP_HOST_NAMES are the fail-safe list.
const fs = require('fs')
const { norm, toStaffEntries, tokens } = require('./participants')
const { isSlackUserId, parseSlackIds, mergeExcludeIds, DEFAULT_FIRST_HOST_SLACK_ID } = require('./slackRoster')

const MAX_PEOPLE = 100
const MAX_NAME = 100
const MAX_ALIASES = 10

function emptyOverrides() {
  return { firstHostSlackId: '', priority: [], excludeIds: [], aliases: {}, people: [] }
}

function asEntry(raw) {
  if (typeof raw === 'string') return { name: raw.trim(), aliases: [], slackId: '' }
  if (!raw || typeof raw !== 'object') return null
  const name = String(raw.name ?? '').trim()
  const slackId = String(raw.slackId || raw.id || '').trim()
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.map((a) => String(a ?? '').trim()).filter(Boolean) : []
  if (!name && !slackId) return null
  return { name, aliases, slackId }
}

function validateEntry(entry) {
  if (!entry || (!entry.name && !entry.slackId)) throw new Error('STAFF list: a person is missing a name')
  if (entry.name && entry.name.length > MAX_NAME) throw new Error('STAFF list: a name is too long')
  if (entry.name && !norm(entry.name)) throw new Error('STAFF list: a name has no letters or digits')
  if (entry.slackId && !isSlackUserId(entry.slackId)) throw new Error('STAFF list: a Slack id is not valid')
  if ((entry.aliases || []).length > MAX_ALIASES) throw new Error('STAFF list: too many aliases on one person')
  for (const a of entry.aliases || []) {
    if (a.length > MAX_NAME) throw new Error('STAFF list: an alias is too long')
    if (!norm(a)) throw new Error('STAFF list: an alias has no letters or digits')
  }
  return entry
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  return value.map((n) => String(n ?? '').trim()).filter(Boolean)
}

// Every key an override object may have. Anything else is REJECTED, never ignored: a misspelt exclusion list ("excludedIds") that was
// silently dropped would leave a shared account eligible as host.
const KNOWN_KEYS = new Set(['firstHostSlackId', 'first_host_slack_id', 'priority', 'excludeIds', 'exclude_ids', 'aliases', 'people', 'staff', 'names'])

// Accepts override objects, a people list (used only as a fail-safe when Slack is down), or a simple name array.
function parseStaffOverrides(data) {
  const out = emptyOverrides()
  if (data == null) return out
  let peopleRaw = []
  if (Array.isArray(data)) {
    peopleRaw = data
  } else if (typeof data === 'object') {
    for (const key of Object.keys(data)) {
      if (!KNOWN_KEYS.has(key)) throw new Error(`STAFF list: unknown setting${/^[A-Za-z_]{1,30}$/.test(key) ? ` "${key}"` : ''} (allowed: firstHostSlackId, priority, excludeIds, aliases, people)`)
    }
    peopleRaw = data.people || data.staff || data.names || []
    if (peopleRaw && !Array.isArray(peopleRaw)) throw new Error('STAFF list: people must be a list')
    out.priority = stringList(data.priority)
    out.firstHostSlackId = String(data.firstHostSlackId || data.first_host_slack_id || '').trim()
    if (out.firstHostSlackId && !isSlackUserId(out.firstHostSlackId)) throw new Error('STAFF list: firstHostSlackId is not a Slack user id')
    const rawExclude = data.excludeIds ?? data.exclude_ids
    if (rawExclude != null) out.excludeIds = parseSlackIds(Array.isArray(rawExclude) ? rawExclude.join(',') : String(rawExclude), { setting: 'STAFF list excludeIds' })
    if (data.aliases && typeof data.aliases === 'object' && !Array.isArray(data.aliases)) {
      for (const [key, aliases] of Object.entries(data.aliases)) {
        out.aliases[key] = (Array.isArray(aliases) ? aliases : [aliases]).map((a) => String(a ?? '').trim()).filter(Boolean)
      }
    }
  } else {
    throw new Error('STAFF list: the JSON must be a list or an object')
  }
  if ((peopleRaw || []).length > MAX_PEOPLE) throw new Error(`STAFF list: at most ${MAX_PEOPLE} people`)
  out.people = (peopleRaw || []).map(asEntry).filter(Boolean).map(validateEntry)
  return out
}

function parseStaffData(data) {
  return parseStaffOverrides(data).people
}

function parseStaffJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return emptyOverrides()
  let data
  try { data = JSON.parse(text) } catch { throw new Error('STAFF_JSON is not valid JSON') }
  return parseStaffOverrides(data)
}

function loadStaffFile(filePath) {
  if (!filePath) return emptyOverrides()
  if (!fs.existsSync(filePath)) throw new Error('STAFF_LIST_PATH does not exist')
  let data
  try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')) } catch { throw new Error('STAFF_LIST_PATH is not valid JSON') }
  return parseStaffOverrides(data)
}

function mergeOverrides(...list) {
  const out = emptyOverrides()
  for (const item of list) {
    if (!item) continue
    if (item.firstHostSlackId) out.firstHostSlackId = item.firstHostSlackId
    out.priority = [...out.priority, ...stringList(item.priority)]
    out.excludeIds = mergeExcludeIds(out.excludeIds, item.excludeIds)
    out.people = [...out.people, ...(item.people || [])]
    for (const [key, aliases] of Object.entries(item.aliases || {})) {
      out.aliases[key] = [...(out.aliases[key] || []), ...aliases]
    }
  }
  return out
}

function addAliases(entry, aliases) {
  const have = new Set([norm(entry.name), ...(entry.aliases || []).map(norm)])
  for (const a of aliases || []) {
    const t = String(a ?? '').trim()
    if (t && norm(t) && !have.has(norm(t))) { entry.aliases.push(t); have.add(norm(t)) }
  }
}

function mergeOverrideAliases(members, overrides) {
  const byId = new Map()
  const byName = new Map()
  for (const m of members) {
    if (m.slackId) byId.set(String(m.slackId).toUpperCase(), m)
    if (m.name) byName.set(norm(m.name), m)
  }
  const apply = (key, aliases) => {
    if (!key) return
    const target = (isSlackUserId(key) && byId.get(key.toUpperCase())) || byName.get(norm(key))
    if (target) addAliases(target, aliases)
  }
  for (const [key, aliases] of Object.entries((overrides && overrides.aliases) || {})) apply(key, aliases)
  for (const p of (overrides && overrides.people) || []) apply(p.slackId || p.name, p.aliases)
}

function asStaffEntry(member) {
  return { name: member.name, aliases: [...(member.aliases || [])], slackId: member.slackId || '' }
}

// When the live roster is present it is the source of truth: only those people can be made host.
// Order is first host (the Slack id in FIRST_HOST_SLACK_ID, else the person named in NEW_HOST_NAME), then optional priority, then everyone else.
// Override JSON may add aliases, change order, or exclude ids (exclusions are applied at fetch time).
// It does not add a person who is not on the roster. When the roster is missing, NEW_HOST_NAME
// and BACKUP_HOST_NAMES (plus any fail-safe people in the override file) are used instead.
function mergeStaff({
  newHostName,
  backupHostNames = [],
  filePeople = [],
  rosterNames = [],
  rosterMembers,
  overrides,
  firstHostSlackId = DEFAULT_FIRST_HOST_SLACK_ID,
} = {}) {
  const peopleFromArg = Array.isArray(filePeople) ? filePeople.filter((p) => p && (p.name || p.aliases || p.slackId)) : []
  const ov = mergeOverrides(overrides, { people: peopleFromArg })

  const roster = rosterMembers || (rosterNames || []).map((n) => (typeof n === 'object' ? { slackId: n.slackId || '', name: n.name, aliases: n.aliases || [] } : { slackId: '', name: n, aliases: [] }))
  // Only people with first name plus at least a last initial can be recognised: a bare first name is never matched, so a one-word
  // roster entry is left out here too (the Slack reader already drops them; this covers a roster handed in some other way).
  const live = (roster || []).filter((m) => m && m.name && tokens(m.name).length >= 2)

  if (live.length) {
    const members = live.map((m) => ({ slackId: m.slackId || '', name: m.name, aliases: [...(m.aliases || [])] }))
    mergeOverrideAliases(members, ov)
    const entries = []
    const used = new Set()
    const mark = (m) => {
      const key = m.slackId ? String(m.slackId).toUpperCase() : `name:${norm(m.name)}`
      if (used.has(key)) return
      used.add(key)
      entries.push(asStaffEntry(m))
    }
    const byId = new Map(members.filter((m) => m.slackId).map((m) => [String(m.slackId).toUpperCase(), m]))
    const byName = new Map(members.map((m) => [norm(m.name), m]))
    const find = (key) => {
      const text = String(key ?? '').trim()
      if (!text) return null
      if (isSlackUserId(text)) return byId.get(text.toUpperCase()) || null
      return byName.get(norm(text)) || members.find((m) => tokens(m.name)[0] === tokens(text)[0] && tokens(text).length === 1 && members.filter((x) => tokens(x.name)[0] === tokens(text)[0]).length === 1) || null
    }
    const firstId = ov.firstHostSlackId || firstHostSlackId
    const first = find(firstId) || find(newHostName)
    if (first) mark(first)
    for (const key of ov.priority) {
      const m = find(key)
      if (m) mark(m)
    }
    for (const m of members) mark(m)
    return entries
  }

  // Fail-safe: Slack was off or failed. Use the configured names only.
  const entries = []
  const index = new Map()
  const add = (name, aliases = [], slackId = '') => {
    const trimmed = String(name ?? '').trim()
    if (!trimmed || !norm(trimmed)) return
    const key = norm(trimmed)
    if (index.has(key)) { addAliases(index.get(key), aliases); return }
    const entry = { name: trimmed, aliases: [], slackId: slackId || '' }
    addAliases(entry, aliases)
    index.set(key, entry)
    entries.push(entry)
  }
  if (newHostName) add(newHostName)
  for (const n of backupHostNames) add(n)
  for (const p of ov.people) add(p.name, p.aliases, p.slackId)
  mergeOverrideAliases(entries, ov)
  return entries
}

function loadFromConfig(cfg = {}) {
  const fromJson = cfg.staffJson ? parseStaffJson(cfg.staffJson) : emptyOverrides()
  const fromFile = cfg.staffListPath ? loadStaffFile(cfg.staffListPath) : emptyOverrides()
  const overrides = mergeOverrides(fromJson, fromFile)
  return mergeStaff({
    newHostName: cfg.newHostName,
    backupHostNames: cfg.backupHostNames,
    overrides,
    firstHostSlackId: cfg.firstHostSlackId || overrides.firstHostSlackId || DEFAULT_FIRST_HOST_SLACK_ID,
  })
}

module.exports = {
  emptyOverrides,
  parseStaffOverrides,
  parseStaffData,
  parseStaffJson,
  loadStaffFile,
  mergeOverrides,
  mergeStaff,
  loadFromConfig,
  toStaffEntries,
}
