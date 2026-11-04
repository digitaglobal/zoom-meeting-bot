'use strict'
// The whole job, step by step, written against a small "driver" so it can be tested without Zoom:
//   driver.join(start)     sign in and start the meeting as host -> { meetingId, link }
//                          (start = { meetingId } starts a meeting that is already on the schedule)
//   driver.people()        everyone in the participants panel (joined and in the waiting room)
//   driver.admit(userId)   let one person in from the waiting room
//   driver.makeHost(id)    Zoom's "Make Host" for one person (including the Yes confirmation)
//   driver.leave()         leave the meeting; it must NEVER end it for everyone
//
// Safety rules: only the person who matches the name is ever admitted or made host, and the bot only leaves
// once Zoom shows the new host. If anything is unclear, it stays.
const { findNewHost, hostTransferred } = require('./participants')

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function runHandover(driver, opts, deps = {}) {
  const sleep = deps.sleep || realSleep
  const now = deps.now || Date.now
  const log = deps.log || (() => {})
  const { newHostName, backupHostNames = [], waitMs, pollMs = 2000, confirmMs = 20000, attempts = 2, onStarted, start, redactNames = true } = opts
  // The first choice comes first. Whoever on the list is seen first gets host; if two are there at the same check, the earlier
  // name on the list wins, so the first choice always beats a backup that happens to be in at the same moment.
  const names = [newHostName, ...backupHostNames]
  // Safe by default: a log must not show anyone's display name unless the caller (a local run) says it may.
  const who = (p) => (redactNames ? 'the new host' : p.userName)
  const upper = (t) => t.charAt(0).toUpperCase() + t.slice(1)
  const label = redactNames ? 'the new host' : names.map((n) => `"${n}"`).join(' or ')

  log(start && start.meetingId ? 'Starting the scheduled meeting as host...' : 'Signing in and starting the meeting as host...')
  const info = await driver.join(start)
  if (onStarted) await onStarted(info)
  log(`Meeting started (ID ${info.meetingId}). Waiting for ${label} to arrive...`)

  // 1. wait for exactly one person who fits; let them in from the waiting room if that is where they are
  const deadline = now() + waitMs
  let target = null
  let usedBackup = false
  let warned = false
  while (now() < deadline) {
    const people = await driver.people()
    const me = people.find((p) => p.isMe)
    const exclude = me && me.userId
    const inside = people.filter((p) => !p.waiting)
    const outside = people.filter((p) => p.waiting)
    const ambiguous = []
    let admitted = false
    for (let i = 0; i < names.length; i++) {
      // a name that fits two people is skipped (never guessed); the next name on the list is still tried
      const joined = findNewHost(inside, { name: names[i] }, { excludeUserId: exclude })
      if (joined.match) { target = joined.match; usedBackup = i > 0; break }
      const waiting = findNewHost(outside, { name: names[i] }, { excludeUserId: exclude })
      if (waiting.match) {
        log(`${i > 0 ? 'A backup host: ' : ''}${upper(who(waiting.match))} is in the waiting room. Letting them in.`)
        await driver.admit(waiting.match.userId)
        admitted = true
        break
      }
      ambiguous.push(...joined.ambiguous, ...waiting.ambiguous)
    }
    if (target) break
    if (admitted) { await sleep(1500); continue }
    if (ambiguous.length && !warned) {
      warned = true
      log(`More than one person fits ${label} (${redactNames ? ambiguous.length + ' people' : ambiguous.map((a) => a.userName).join(', ')}). Not guessing; waiting for it to be clear.`)
    }
    await sleep(pollMs)
  }
  if (!target) return { ok: false, reason: 'new-host-not-found', detail: `${redactNames ? 'The new host' : label} did not arrive (or could not be told apart) within the wait time.`, info }

  // 2. hand over host, and wait for Zoom to show it
  log(`Found ${usedBackup ? 'a backup host: ' : ''}${who(target)}. Making them the host...`)
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await driver.makeHost(target.userId)
    const until = now() + confirmMs
    while (now() < until) {
      const people = await driver.people()
      if (hostTransferred({ people, targetUserId: target.userId })) {
        log(`Zoom shows ${who(target)} as the host. Leaving the meeting (not ending it).`)
        await driver.leave()
        return { ok: true, target, usedBackup, info }
      }
      await sleep(1000)
    }
    log(`Not confirmed yet (try ${attempt} of ${attempts}).`)
  }
  return { ok: false, reason: 'host-transfer-not-confirmed', detail: 'Zoom did not show the change, so the bot stayed in the meeting.', target, info }
}

module.exports = { runHandover }
