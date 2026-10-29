'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { parseUpcoming, dueMeetings, clockToMinutes, minutesNow, clockText } = require('../../src/upcoming')

// Shaped like the real Upcoming page text. Every name and meeting number here is INVENTED (this file is public).
const PAGE = [
  'Upcoming', 'Previous', 'Personal Room', 'Meeting Templates',
  'Today',
  '01:46 AM - 02:16 AM', 'HOST', '', 'Meeting ID: 111 000 0001', '', 'Start', 'Chat', 'Edit', 'Delete',
  '09:00 AM - 09:30 AM', 'Ann Example Admin Assistant Interview', '', 'Meeting ID: 111 000 0002', '', 'Join', 'End', 'Chat', 'Edit',
  '09:30 AM - 10:00 AM', 'Bea Example Admin Assistant Interview', '', 'Meeting ID: 111 000 0003', '', 'Start', 'Chat', 'Edit', 'Delete',
  '10:00 AM - 10:30 AM', 'Cy Example Admin Assistant Interview', '', 'Meeting ID: 111 000 0004', '', 'Start', 'Chat', 'Edit', 'Delete',
  '11:00 AM - 11:30 AM', '30 min meeting between Acme and Jo Booker', '', 'Meeting ID: 111 000 0005', '', 'Start', 'Chat', 'Edit', 'Delete',
  'Save time by scheduling your meetings directly from your calendar.',
].join('\n')

const ANN = '1110000002'
const BEA = '1110000003'
const CY = '1110000004'
const BOOKER = '1110000005'

// Jamaica is UTC-5 all year, so 14:20Z is 09:20 in Jamaica.
const at = (h, m, s = 0) => new Date(Date.UTC(2026, 9, 29, h + 5, m, s))
const INTERVIEW = /interview/i
const due = (now, extra = {}) => dueMeetings(parseUpcoming(PAGE), now, { filter: INTERVIEW, ...extra }).map((m) => m.id)

test('parseUpcoming: reads every meeting of today, with its buttons', () => {
  const m = parseUpcoming(PAGE)
  assert.equal(m.length, 5)
  assert.deepEqual(m[2], { start: '09:30 AM', end: '10:00 AM', title: 'Bea Example Admin Assistant Interview', id: BEA, buttons: ['Start', 'Chat', 'Edit', 'Delete'] })
  assert.deepEqual(m[1].buttons, ['Join', 'End', 'Chat', 'Edit'], 'a running meeting shows Join / End')
  assert.equal(m[0].id, '1110000001')
})

test('parseUpcoming: nothing today, or an unrecognised page, gives an empty list', () => {
  assert.deepEqual(parseUpcoming(''), [])
  assert.deepEqual(parseUpcoming('Upcoming\nNo meetings'), [])
  assert.deepEqual(parseUpcoming(null), [])
})

test("parseUpcoming: stops at the next day, so tomorrow's meetings are never started today", () => {
  const text = 'Today\n09:30 AM - 10:00 AM\nA Interview\nMeeting ID: 111 222 3333\nStart\nChat\nFri, Oct 30, 2026\n09:30 AM - 10:00 AM\nB Interview\nMeeting ID: 444 555 6666\nStart\nChat'
  const m = parseUpcoming(text)
  assert.equal(m.length, 1)
  assert.equal(m[0].title, 'A Interview')
})

test('parseUpcoming: an unknown extra button does not hide the meetings after it', () => {
  const text = 'Today\n09:30 AM - 10:00 AM\nA\nMeeting ID: 111 222 3333\nStart\nSomething New\nChat\n10:00 AM - 10:30 AM\nB\nMeeting ID: 444 555 6666\nStart'
  assert.equal(parseUpcoming(text).length, 2)
})

test('clockToMinutes: AM/PM, noon and midnight', () => {
  assert.equal(clockToMinutes('09:30 AM'), 570)
  assert.equal(clockToMinutes('12:00 AM'), 0)
  assert.equal(clockToMinutes('12:15 PM'), 735)
  assert.equal(clockToMinutes('1:05 PM'), 785)
  assert.equal(clockToMinutes('11:59 PM'), 1439)
  assert.equal(clockToMinutes('nonsense'), null)
})

test('Jamaica time: a computer set to another zone gives the same answer', () => {
  const old = process.env.TZ
  try {
    for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = tz
      assert.equal(minutesNow(at(9, 20), 'America/Jamaica'), 9 * 60 + 20, `computer zone ${tz}`)
      assert.equal(clockText(at(9, 20), 'America/Jamaica'), '9:20 AM')
    }
  } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old }
})

test('due: a meeting is picked up from 10 minutes before its start', () => {
  assert.deepEqual(due(at(9, 19, 30)), [], '10.5 minutes ahead is too early')
  assert.deepEqual(due(at(9, 20)), [BEA], 'exactly 10 minutes ahead')
  assert.deepEqual(due(at(9, 25)), [BEA])
  assert.deepEqual(due(at(9, 30)), [BEA])
})

test('due: a slightly late run still starts the meeting, but a finished meeting is not restarted', () => {
  assert.deepEqual(due(at(9, 34)), [BEA], '4 minutes late: still started')
  assert.deepEqual(due(at(9, 35)), [BEA], 'exactly 5 minutes late')
  assert.deepEqual(due(at(9, 36)), [], '6 minutes late: too late (it may have run and finished; Zoom lists it with Start again)')
  assert.deepEqual(due(at(9, 46)), [])
})

test('due: meetings already running (Join / End) are never started again', () => {
  assert.deepEqual(due(at(9, 0)), [], 'the 9:00 meeting shows Join / End')
  assert.deepEqual(due(at(8, 55)), [], 'even in its own lead window')
})

test("due: only meetings that match the filter (a booking-page meeting is skipped by default)", () => {
  assert.deepEqual(due(at(10, 55)), [])
  assert.deepEqual(dueMeetings(parseUpcoming(PAGE), at(10, 55), { filter: null }).map((m) => m.id), [BOOKER], 'no filter = every meeting')
})

test('due: the most overdue meeting comes first', () => {
  assert.deepEqual(due(at(9, 52), { lateMinutes: 25 }), [BEA, CY])
})

test('due: lead and late windows are adjustable', () => {
  assert.deepEqual(due(at(9, 29), { leadMinutes: 0 }), [], '1 minute ahead with no lead time')
  assert.deepEqual(due(at(9, 30), { leadMinutes: 0 }), [BEA])
  assert.deepEqual(due(at(9, 20), { leadMinutes: 5 }), [])
  assert.deepEqual(due(at(9, 46), { lateMinutes: 20 }), [BEA])
})

test('due: midnight and noon are read correctly', () => {
  const t = 'Today\n12:00 AM - 12:30 AM\nX Interview\nMeeting ID: 111 222 3333\nStart\n12:30 PM - 01:00 PM\nY Interview\nMeeting ID: 444 555 6666\nStart'
  assert.deepEqual(dueMeetings(parseUpcoming(t), at(0, 0), { filter: INTERVIEW }).map((m) => m.id), ['1112223333'])
  assert.deepEqual(dueMeetings(parseUpcoming(t), at(12, 25), { filter: INTERVIEW }).map((m) => m.id), ['4445556666'])
})

test('due: a meeting with no readable number is never started', () => {
  const t = 'Today\n09:30 AM - 10:00 AM\nA Interview\nStart'
  assert.deepEqual(dueMeetings(parseUpcoming(t), at(9, 25), { filter: INTERVIEW }), [])
})
