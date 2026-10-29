'use strict'
// Reads Zoom's "Upcoming meetings" list and decides which meeting is due. Pure functions, so the timing rules
// (especially Jamaica time) can be tested without Zoom. Zoom shows these times in the account's own time zone,
// which for Digita Global is UTC-5 (Jamaica has no daylight saving, so that never shifts).
//
// The page text looks like:
//   Today
//   09:30 AM - 10:00 AM
//   Ann Example Interview
//   Meeting ID: 111 222 3333
//   Start / Chat / Edit / Delete        (a meeting already running shows Join / End instead of Start)

const TIME_RANGE = /^(\d{1,2}:\d{2}\s?[AP]M)\s*-\s*(\d{1,2}:\d{2}\s?[AP]M)$/i
const MEETING_ID = /^Meeting ID:\s*([\d ]{9,15})$/i
const BUTTONS = new Set(['Start', 'Join', 'End', 'Chat', 'Edit', 'Delete', 'Copy Invitation', 'Show Meeting Invitation', 'Hide Meeting Invitation', 'Copy invitation'])
const DATE_HEADER = /^(Tomorrow|Yesterday|(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\b.*|(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.? \d{1,2}\b.*)$/i

// "09:30 AM" -> minutes after midnight (570)
function clockToMinutes(text) {
  const m = /^(\d{1,2}):(\d{2})\s?([AP])M$/i.exec(String(text).trim())
  if (!m) return null
  let h = Number(m[1]) % 12
  if (m[3].toUpperCase() === 'P') h += 12
  return h * 60 + Number(m[2])
}

// Minutes after midnight, right now, in the given time zone (seconds included as a fraction).
function minutesNow(now, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const get = (t) => Number(parts.find((p) => p.type === t).value)
  return get('hour') * 60 + get('minute') + get('second') / 60
}

function clockText(now, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(now)
}

// Only the "Today" section matters: the bot acts on meetings that are about to start.
function parseUpcoming(text) {
  const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const today = lines.indexOf('Today')
  if (today < 0) return []
  const out = []
  for (let i = today + 1; i < lines.length; i++) {
    const t = TIME_RANGE.exec(lines[i])
    if (!t) {
      if (out.length && DATE_HEADER.test(lines[i])) break // the next day starts here
      continue
    }
    const meeting = { start: t[1].toUpperCase(), end: t[2].toUpperCase(), title: lines[i + 1] || '', id: '', buttons: [] }
    let j = i + 2
    for (let k = 0; k < 4 && j < lines.length && !TIME_RANGE.test(lines[j]); k++, j++) {
      const id = MEETING_ID.exec(lines[j])
      if (id) { meeting.id = id[1].replace(/\s/g, ''); j++; break }
    }
    while (j < lines.length && BUTTONS.has(lines[j])) meeting.buttons.push(lines[j++])
    out.push(meeting)
    i = j - 1
  }
  return out
}

// A meeting is "startable" only if it has a Start button and is not already running (Join / End).
const isStartable = (m) => m.buttons.includes('Start') && !m.buttons.includes('Join') && !m.buttons.includes('End')

// Meetings to start now: not running yet, title matches, and the start time is within `leadMinutes` ahead
// or at most `lateMinutes` behind (a run that fires late still starts the meeting). The late window is short on
// purpose: Zoom lists a meeting that already finished (say, a candidate who left after 10 minutes) with a Start
// button again, and the bot must not start it a second time.
function dueMeetings(meetings, now, opts = {}) {
  const { timeZone = 'America/Jamaica', leadMinutes = 10, lateMinutes = 5, filter = null } = opts
  const nowMin = minutesNow(now, timeZone)
  return meetings
    .filter((m) => m.id && isStartable(m))
    .filter((m) => !filter || filter.test(m.title))
    .map((m) => ({ ...m, startsInMinutes: clockToMinutes(m.start) - nowMin }))
    .filter((m) => Number.isFinite(m.startsInMinutes) && m.startsInMinutes <= leadMinutes && m.startsInMinutes >= -lateMinutes)
    .sort((a, b) => a.startsInMinutes - b.startsInMinutes) // the most overdue meeting first
}

module.exports = { parseUpcoming, dueMeetings, isStartable, clockToMinutes, minutesNow, clockText, TIME_RANGE }
