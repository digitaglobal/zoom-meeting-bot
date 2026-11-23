'use strict'
// Pure helpers: who is the person to hand host to, and has the hand-over really happened?
// A "person" is { userId, userName, isMe, isHost, waiting } as read from Zoom's participants panel.
//
// Matching is case, accent and punctuation insensitive. A staff full name such as "Jordan Banks"
// fits Zoom display names "Jordan Banks", "Jordan Banks (iPhone)", "Jordan B" and "Jordan B.".
// After a name only a device word or a note in brackets may follow: "Jordan Banks (Marketing)" fits, "Dr Jordan Banks",
// "Jordan Banks Smith" and "Jordan Banks - Digita" do not (a stranger whose name merely contains a staff name is not that person).
// A BARE FIRST NAME NEVER MATCHES a staff member whose name has two or more words: "Jordan" or "Jordan (iPhone)" is not enough,
// even when nobody else on the staff shares that first name, and one-word aliases (a nickname, a Slack display name that is just a
// first name) are ignored for such a person. At least first name plus last initial is required.
// The one exception is a ONE-WORD name that an operator typed by hand (NEW_HOST_NAME="Jordan", the old public default): it keeps
// the old whole-word rule, including the rule that two people who both fit are ambiguous (never guessed).

const KIND_RANK = { exact: 4, contains: 3, 'first-last-initial': 2, 'first-name': 1 }

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // accents: "Kemál" matches "Jordan"
    .replace(/[^a-z0-9 ]+/g, ' ') // "Jordan-Test" / "Jordan B." -> "jordan test" / "jordan b"
    .replace(/\s+/g, ' ')
    .trim()

const tokens = (s) => norm(s).split(' ').filter(Boolean)

function middleTokenFits(staff, disp) {
  if (staff === disp) return true
  if (disp.length === 1 && staff[0] === disp) return true
  if (staff.length === 1 && disp[0] === staff) return true
  return false
}

// Display middles may be omitted ("Mary Ann Smith" vs "Mary S") or shortened to initials.
// Extra display middles that the staff name does not have are refused.
function middlesFit(staffMid, dispMid) {
  if (dispMid.length === 0) return true
  if (dispMid.length > staffMid.length) return false
  for (let i = 0; i < dispMid.length; i++) {
    if (!middleTokenFits(staffMid[i], dispMid[i])) return false
  }
  return true
}

// Only a display last name that is JUST the initial fits a staff last name: "banks" ~ "b". The reverse (a staff form "Jordan B" fitting
// ANY display last name that starts with B: "Jordan Bishop", "Jordan Burke", a phone called "Galaxy") is NOT allowed: it would admit a
// stranger who only shares the first name and an initial. The full name itself is matched exactly by the official name.
function lastInitialFits(staffLast, dispLast) {
  if (!staffLast || !dispLast) return false
  return staffLast.length >= 2 && dispLast.length === 1 && staffLast[0] === dispLast
}

// Tokens that look like a device note after a person's name ("Jordan B. (iPhone)"), not a last name.
const DEVICE_NOTES = new Set(['iphone', 'ipad', 'android', 'mobile', 'phone', 'galaxy', 'web', 'app', 'desktop', 'mac', 'windows', 'pc', 'tablet', 'laptop'])

// Where the phrase s sits inside d (token positions), or -1. Only a ONE-WORD name typed by hand still uses this (whole word anywhere).
function phraseAt(s, d) {
  for (let i = 0; i + s.length <= d.length; i++) {
    let ok = true
    for (let k = 0; k < s.length; k++) if (d[i + k] !== s[k]) { ok = false; break }
    if (ok) return i
  }
  return -1
}

// "Jordan Banks (Marketing) [iPhone]" -> "Jordan Banks": drops notes written in brackets at the END of a display name. A bracketed
// note is how people and devices add context to a name; a stranger whose real name merely contains a staff name ("Maria Lopez Garcia"
// next to staff "Maria Lopez") never looks like that. Input is capped, so a hostile display name cannot make this slow.
function stripTrailingNotes(raw) {
  let t = String(raw ?? '').slice(0, 200).trim()
  for (let i = 0; i < 5; i++) {
    const next = t.replace(/\s*[(\[{][^()\[\]{}]*[)\]}]\s*$/, '')
    if (next === t) break
    t = next
  }
  return t
}

// The words of a display name once trailing bracketed notes and trailing device words are removed (never fewer than two words left).
function coreTokens(displayName) {
  const t = tokens(stripTrailingNotes(displayName))
  let end = t.length
  while (end > 2 && DEVICE_NOTES.has(t[end - 1])) end--
  return t.slice(0, end)
}

function matchOne(form, displayName) {
  const s = tokens(form)
  const d = tokens(displayName)
  if (!s.length || !d.length) return null
  // A real Zoom display name is far shorter than this. An over-long one never matches (it is never cut short, which could hide words), and it bounds the work.
  if (String(displayName ?? '').length > 200) return null
  // A form that ends in a single letter is first name plus last INITIAL ("Jordan B"). It can never be better than
  // 'first-last-initial', even when it equals the display name exactly: an initial form is also what a stranger with the same first
  // name and last-name letter would type, so it must rank BELOW the real full name ("Avery Stone (iPhone)" beats "Avery S") and
  // two staff who share a first name and initial must collide ("Jordan B" fits both Jordan Banks and Jordan Bishop: do nothing).
  const initialForm = s.length >= 2 && s[s.length - 1].length === 1
  if (s.join(' ') === d.join(' ')) return initialForm ? 'first-last-initial' : 'exact'
  // A ONE-WORD name typed by hand (the old public default) keeps the old whole-word rule.
  if (s.length === 1) return phraseAt(s, d) >= 0 ? 'first-name' : null
  // After the name only a note in brackets or a device word may follow. Words before it, or other words after it ("Dr Jordan Banks",
  // "Not Jordan Banks", "Jordan Banks Smith", "Jordan Banks - Digita", "Maria Lopez Garcia") belong to somebody else.
  const core = coreTokens(displayName)
  if (core.join(' ') === s.join(' ')) return initialForm ? 'first-last-initial' : 'contains'
  if (core.length >= 2 && s[0] === core[0]) {
    const staffLast = s[s.length - 1]
    const dispLast = core[core.length - 1]
    const lastOk = staffLast === dispLast || lastInitialFits(staffLast, dispLast)
    if (lastOk && middlesFit(s.slice(1, -1), core.slice(1, -1))) {
      // Full last name with a shortened middle ("Mary A. Smith") is still a strong match.
      return staffLast === dispLast && !initialForm ? 'contains' : 'first-last-initial'
    }
  }
  return null
}

// Best kind among the official name and its aliases, or null if none fit.
function matchKind(staffName, displayName, aliases = []) {
  let best = matchOne(staffName, displayName)
  const multiWord = tokens(staffName).length >= 2
  for (const form of aliases || []) {
    // A multi-word staff name is never recognised by a one-word alias (a bare first name, a nickname, a one-word Slack display name):
    // a stranger could simply type it. Every alias of such a person needs at least two words, e.g. "Jordan B".
    if (multiWord && tokens(form).length < 2) continue
    const kind = matchOne(form, displayName)
    if (kind && (!best || KIND_RANK[kind] > KIND_RANK[best])) best = kind
  }
  return best
}

function entryOf(nameOrEntry, aliases) {
  if (nameOrEntry && typeof nameOrEntry === 'object') {
    return { name: nameOrEntry.name, aliases: nameOrEntry.aliases || [] }
  }
  return { name: nameOrEntry, aliases: aliases || [] }
}

// Returns { match, kind } when exactly one person fits at the best tier, { match: null, ambiguous: [...] }
// when several do at that same tier (we then do NOTHING rather than guess), and { match: null, ambiguous: [] }
// when nobody fits. Never picks the bot itself.
//
// Tiers, for a multi-word staff name: exact, then a full-name phrase inside the display name
// ("Jordan Banks (iPhone)"), then first name + last initial ("Jordan B" / "Jordan B.").
// A higher tier beats a lower one, so "Jordan Banks" is chosen over a guest who only joined as "Jordan B"
// when the staff name is the full name. A one-word search ("Jordan") keeps the old rule: every whole-word
// fit is the same tier, so a guest who typed just "Jordan" next to "Jordan Example" stays ambiguous.
function findNewHost(people, { name, aliases } = {}, { excludeUserId } = {}) {
  const entry = entryOf(name, aliases)
  const candidates = (people || []).filter((p) => p && !p.isMe && String(p.userId) !== String(excludeUserId))
  if (!norm(entry.name) && !(entry.aliases || []).some((a) => norm(a))) return { match: null, ambiguous: [], kind: null }
  const scored = []
  for (const p of candidates) {
    const kind = matchKind(entry.name, p.userName, entry.aliases)
    if (kind) scored.push({ p, kind, rank: KIND_RANK[kind] })
  }
  if (!scored.length) return { match: null, ambiguous: [], kind: null }
  const singleWord = tokens(entry.name).length < 2 && !(entry.aliases || []).some((a) => tokens(a).length >= 2)
  const best = singleWord ? Math.min(...scored.map((x) => x.rank)) : Math.max(...scored.map((x) => x.rank))
  // For a one-word search, flatten to the lowest rank so exact "Jordan" does not beat "Jordan Example".
  const top = singleWord ? scored : scored.filter((x) => x.rank === best)
  if (top.length === 1) return { match: top[0].p, ambiguous: [], kind: top[0].kind }
  return { match: null, ambiguous: top.map((x) => x.p), kind: null }
}

// An initial-form match must not be given to the earlier staff name when a later staff
// name also fits that same Zoom person at the same tier: "Jordan B" cannot be guessed as Jordan Banks
// when Jordan Bishop is also on the staff list.
function hasStaffCollision(person, staffIndex, entries, kind) {
  const rank = KIND_RANK[kind] || 0
  if (rank >= KIND_RANK.contains) return false
  for (let j = 0; j < (entries || []).length; j++) {
    if (j === staffIndex) continue
    const other = matchKind(entries[j].name, person.userName, entries[j].aliases)
    if (other && KIND_RANK[other] === rank) return true
  }
  return false
}

// Walk the staff list in priority order (first choice, then backups, then the rest). For each name,
// a unique person already inside wins; otherwise a unique person in the waiting room is returned
// with waiting: true so the bot can let them in, even if a lower-priority staff member is already
// inside. usedBackup is true when the chosen staff entry is not the first one on the list.
function pickFromPanel({ inside, outside, entries, excludeUserId } = {}) {
  const ambiguous = []
  const list = entries || []
  for (let i = 0; i < list.length; i++) {
    const joined = findNewHost(inside, list[i], { excludeUserId })
    if (joined.match) {
      if (hasStaffCollision(joined.match, i, list, joined.kind)) { ambiguous.push(joined.match); continue }
      return { match: joined.match, waiting: false, kind: joined.kind, usedBackup: i > 0, staff: list[i], ambiguous }
    }
    if (joined.ambiguous.length) ambiguous.push(...joined.ambiguous)
    const waiting = findNewHost(outside, list[i], { excludeUserId })
    if (waiting.match) {
      if (hasStaffCollision(waiting.match, i, list, waiting.kind)) { ambiguous.push(waiting.match); continue }
      return { match: waiting.match, waiting: true, kind: waiting.kind, usedBackup: i > 0, staff: list[i], ambiguous }
    }
    if (waiting.ambiguous.length) ambiguous.push(...waiting.ambiguous)
  }
  return { match: null, waiting: false, kind: null, usedBackup: false, staff: null, ambiguous }
}

function toStaffEntries(names) {
  return (names || []).filter((n) => n && String(n).trim()).map((n) => (typeof n === 'object' ? { name: n.name, aliases: n.aliases || [] } : { name: String(n).trim(), aliases: [] }))
}

// True only when Zoom itself shows the change: the bot is no longer host, or the target now is.
// If neither is visible we treat it as NOT confirmed (the bot then stays rather than leaving).
function hostTransferred({ people, targetUserId }) {
  const me = (people || []).find((p) => p.isMe)
  if (me && me.isHost === false) return true
  const target = (people || []).find((p) => String(p.userId) === String(targetUserId))
  return !!(target && target.isHost === true)
}

module.exports = { norm, tokens, matchOne, matchKind, findNewHost, hasStaffCollision, pickFromPanel, toStaffEntries, hostTransferred, KIND_RANK }
