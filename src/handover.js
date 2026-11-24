'use strict'
// The whole job, step by step, written against a small "driver" so it can be tested without Zoom:
//   driver.join(start)     sign in and start the meeting as host -> { meetingId, link }
//                          (start = { meetingId } starts a meeting that is already on the schedule)
//   driver.people()        everyone in the participants panel (joined and in the waiting room)
//   driver.admit(userId)   let one person in from the waiting room
//   driver.makeHost(id)    Zoom's "Make Host" for one person (including the Yes confirmation)
//   driver.leave()         leave the meeting; it must NEVER end it for everyone
//
// Safety rules: only a person who matches a staff name is ever admitted or made host, and the bot only leaves
// once Zoom shows the new host. If anything is unclear, it stays. dryHandover logs the person it would
// make host and never clicks Admit or Make Host.
const { hostTransferred, pickFromPanel, admissibleStaff } = require('./participants')
const { mergeStaff } = require('./staffList')

// ADMIT_ALL_STAFF: how long to leave a person alone after clicking Admit for them (the panel can lag), and how many times to click
// for the same person before giving up on them (the new host can still let them in by hand).
const STAFF_RETRY_MS = 15000
const MAX_STAFF_CLICKS = 3
// A short pause after letting staff in, so the participants list can settle before the Make Host menu is opened.
const STAFF_SETTLE_MS = 1000
// If the click that lets the host candidate in fails (they left, or the panel moved), look again; this many failures in a row end the run.
const MAX_HOST_ADMIT_FAILURES = 3

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runHandover(driver, opts, deps = {}) {
  const sleep = deps.sleep || realSleep
  const now = deps.now || Date.now
  const log = deps.log || (() => {})
  const { newHostName, backupHostNames = [], staffEntries, staffOverrides, firstHostSlackId, getRosterNames, rosterRefreshMs = 10 * 60 * 1000, waitMs, pollMs = 2000, confirmMs = 20000, attempts = 2, onStarted, start, redactNames = true, dryHandover = false, admitAllStaff = false, excludeIds = [] } = opts
  // Fail-safe names are used until Slack answers, and again if Slack cannot be read.
  // When the live roster arrives, it becomes the source of truth: the first host first (by Slack id, else by NEW_HOST_NAME), then any
  // optional priority, then everyone else currently active. Whoever on that list is seen first gets host.
  const fixedEntries = (staffEntries && staffEntries.length)
    ? staffEntries.map((e) => ({ name: e.name, aliases: e.aliases || [], slackId: e.slackId || '' }))
    : mergeStaff({ newHostName, backupHostNames, overrides: staffOverrides })
  let entries = fixedEntries
  let rosterAt = -Infinity
  let rosterLogged = false
  const refreshRoster = async () => {
    if (!getRosterNames) return
    rosterAt = now()
    try {
      const roster = await getRosterNames()
      const list = roster || []
      const rosterMembers = list.length && typeof list[0] === 'object' ? list : null
      const rosterNames = list.length && typeof list[0] === 'string' ? list : []
      entries = mergeStaff({ newHostName, backupHostNames, overrides: staffOverrides, rosterMembers, rosterNames, firstHostSlackId })
      if (!rosterLogged) { rosterLogged = true; log(`Read the current Slack member list (${entries.length} people can be made host).`) }
    } catch (e) {
      // never fatal: the meeting is already live, so carry on with the fail-safe names (or the last good roster)
      log(`Could not read the Slack member list (${e && e.message ? e.message : 'unknown problem'}); using the names it already has.`)
    }
  }
  // Safe by default: a log must not show anyone's display name unless the caller (a local run) says it may.
  const who = (p) => (redactNames ? 'the new host' : p.userName)
  const upper = (t) => t.charAt(0).toUpperCase() + t.slice(1)
  const label = redactNames ? 'the new host' : fixedEntries.map((e) => `"${e.name}"`).join(' or ')
  const kindLabel = (kind) => (kind === 'first-last-initial' ? 'first name and last initial' : kind || 'name')

  // ADMIT_ALL_STAFF (off unless the caller turns it on). While the bot is host, every check of the waiting room also lets in each person
  // who fits exactly one staff member (see admissibleStaff), not only the one who is about to be made host. Guests, names that two staff
  // could fit, and a bare first name stay in the waiting room. This never changes WHO gets host (that is still pickFromPanel, below), it
  // never touches the person the host rule is already admitting (skipUserIds), and a failed click here is logged and never stops the
  // hand-over. A dry run only says what it would do.
  const staffClicks = new Map() // userId -> { at, clicks }
  const staffAnnounced = new Set()
  const staffLetIn = new Set()
  let staffRefusedLogged = false
  const admitWaitingStaff = async (people, skipUserIds = []) => {
    if (!admitAllStaff) return 0
    const me = people.find((p) => p.isMe)
    const { admit, refused } = admissibleStaff({ people, entries, excludeUserId: me && me.userId, excludeSlackIds: excludeIds })
    const skip = new Set(skipUserIds.map(String))
    if (refused.length && !staffRefusedLogged) {
      staffRefusedLogged = true
      // A public log says neither who nor how many.
      log(`${redactNames ? 'Someone' : refused.map((r) => r.person.userName).join(', ')} in the waiting room could be more than one staff member, or shares a name with someone else. Not letting them in.`)
    }
    let clicked = 0
    for (const { person, kind } of admit) {
      const id = String(person.userId)
      if (skip.has(id)) continue
      if (dryHandover) {
        if (!staffAnnounced.has(id)) { staffAnnounced.add(id); log(`Dry run: would let ${redactNames ? 'a staff member' : `${person.userName} (matched as ${kindLabel(kind)})`} in from the waiting room. Not clicking.`) }
        continue
      }
      const seen = staffClicks.get(id)
      if (seen && (seen.clicks >= MAX_STAFF_CLICKS || now() - seen.at < STAFF_RETRY_MS)) continue
      staffClicks.set(id, { at: now(), clicks: (seen ? seen.clicks : 0) + 1 })
      log(`${seen ? 'Trying again to let' : 'Letting'} ${redactNames ? 'a staff member' : `${person.userName} (staff, matched as ${kindLabel(kind)})`} in from the waiting room.`)
      try {
        await driver.admit(person.userId)
        staffLetIn.add(id)
        clicked++
      } catch (e) {
        log(`Could not let a staff member in (${e && e.message ? e.message : 'unknown problem'}). The hand-over carries on.`)
      }
    }
    if (clicked) await sleep(STAFF_SETTLE_MS)
    return clicked
  }
  const staffNote = () => (admitAllStaff && staffLetIn.size && !redactNames ? ` Let in ${staffLetIn.size} other staff member(s) from the waiting room while waiting.` : '')

  log(start && start.meetingId ? 'Starting the scheduled meeting as host...' : 'Signing in and starting the meeting as host...')
  const info = await driver.join(start)
  if (onStarted) await onStarted(info)
  log(dryHandover
    ? `Meeting started (ID ${info.meetingId}). Dry run: waiting to see who would be made host, and not clicking Admit or Make Host.`
    : `Meeting started (ID ${info.meetingId}). Waiting for ${label} to arrive...`)
  await refreshRoster()

  // 1. wait for exactly one person who fits; let them in from the waiting room if that is where they are
  const deadline = now() + waitMs
  let target = null
  let usedBackup = false
  let warned = false
  let pickedKind = null
  let hostAdmitFailures = 0
  while (now() < deadline) {
    if (getRosterNames && now() - rosterAt >= rosterRefreshMs) await refreshRoster()
    const people = await driver.people()
    const me = people.find((p) => p.isMe)
    const exclude = me && me.userId
    const inside = people.filter((p) => !p.waiting)
    const outside = people.filter((p) => p.waiting)
    const picked = pickFromPanel({ inside, outside, entries, excludeUserId: exclude })
    const hostWaiting = !!(picked.match && picked.waiting)
    // ADMIT_ALL_STAFF: let in every other staff member who is waiting. When the host rule has someone to let in, that person is let in
    // FIRST (below) and the others follow in the wait loop, so the extra clicks can never make the host candidate slip away.
    if (!hostWaiting || dryHandover) await admitWaitingStaff(people, hostWaiting ? [picked.match.userId] : [])
    if (picked.match && !picked.waiting) { target = picked.match; usedBackup = picked.usedBackup; pickedKind = picked.kind; break }
    if (picked.match && picked.waiting) {
      if (dryHandover) {
        log(`Dry run: would let ${picked.usedBackup ? 'a backup host: ' : ''}${who(picked.match)} in from the waiting room and make them host (matched as ${kindLabel(picked.kind)}). Not clicking.`)
        return { ok: true, dryRun: true, wouldAdmit: true, wouldMakeHost: true, target: picked.match, usedBackup: picked.usedBackup, kind: picked.kind, staff: picked.staff, info }
      }
      log(`${picked.usedBackup ? 'A backup host: ' : ''}${upper(who(picked.match))} is in the waiting room. Letting them in.`)
      try {
        await driver.admit(picked.match.userId)
        hostAdmitFailures = 0
      } catch (e) {
        // The person may have left, or the panel may have moved, between reading it and clicking. Look again instead of giving up;
        // a click that keeps failing (3 times in a row) still ends the run with the error, exactly as before.
        hostAdmitFailures++
        if (hostAdmitFailures >= MAX_HOST_ADMIT_FAILURES) throw e
        log(`Could not let them in yet (${e && e.message ? e.message : 'unknown problem'}). Looking at the waiting room again.`)
        await sleep(pollMs)
        continue
      }
      // Re-read the panel until the admitted person shows up in the "in the meeting" list (up to ~20 seconds).
      // The old fixed 1.5-second pause was often too short for the row (and its More button) to finish moving.
      // Only the staff entry that was just admitted counts here, so a lower-priority person who happens to be
      // inside already is never picked early; the outer loop still handles everyone else.
      const insideUntil = now() + Math.min(20000, Math.max(0, deadline - now()))
      while (now() < insideUntil) {
        await sleep(500)
        const fresh = await driver.people()
        const meNow = fresh.find((p) => p.isMe)
        await admitWaitingStaff(fresh, [picked.match.userId])
        const arrived = pickFromPanel({ inside: fresh.filter((p) => !p.waiting), outside: [], entries, excludeUserId: meNow && meNow.userId })
        if (arrived.match && !arrived.waiting && arrived.staff === picked.staff) {
          target = arrived.match; usedBackup = arrived.usedBackup; pickedKind = arrived.kind
          break
        }
      }
      if (target) break
      continue
    }
    if (picked.ambiguous.length && !warned) {
      warned = true
      log(`More than one person fits ${label} (${redactNames ? picked.ambiguous.length + ' people' : picked.ambiguous.map((a) => a.userName).join(', ')}). Not guessing; waiting for it to be clear.`)
    }
    await sleep(pollMs)
  }
  if (!target) return { ok: false, reason: 'new-host-not-found', detail: `${redactNames ? 'The new host' : label} did not arrive (or could not be told apart) within the wait time.`, info }

  if (dryHandover) {
    log(`Dry run: would make ${usedBackup ? 'a backup host: ' : ''}${who(target)} the host (matched as ${kindLabel(pickedKind)}). Not clicking.`)
    return { ok: true, dryRun: true, wouldAdmit: false, wouldMakeHost: true, target, usedBackup, kind: pickedKind, info }
  }

  // 2. hand over host, and wait for Zoom to show it
  log(`Found ${usedBackup ? 'a backup host: ' : ''}${who(target)}. Making them the host...`)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await driver.makeHost(target.userId)
    } catch (e) {
      const msg = e && e.message ? e.message : 'unknown problem'
      log(`The new host was found, but the hand-over click failed (${msg}).`)
      if (attempt < attempts) {
        log(`Trying the menu again (try ${attempt} of ${attempts}).`)
        continue
      }
      return { ok: false, reason: 'host-menu-failed', detail: 'The new host joined, but the bot could not open their participant menu to make them host. The bot is staying in the meeting as host: please check it now.', target, info }
    }
    const until = now() + confirmMs
    while (now() < until) {
      const people = await driver.people()
      if (hostTransferred({ people, targetUserId: target.userId })) {
        log(`Zoom shows ${who(target)} as the host. Leaving the meeting (not ending it).${staffNote()}`)
        await driver.leave()
        // otherStaffLetIn = the staff let in by ADMIT_ALL_STAFF besides the new host (0 when the setting is off)
        return { ok: true, target, usedBackup, kind: pickedKind, info, otherStaffLetIn: staffLetIn.size }
      }
      await sleep(1000)
    }
    log(`Not confirmed yet (try ${attempt} of ${attempts}).`)
  }
  return { ok: false, reason: 'host-transfer-not-confirmed', detail: 'Zoom did not show the change, so the bot stayed in the meeting.', target, info }
}

module.exports = { runHandover }
