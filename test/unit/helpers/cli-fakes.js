'use strict'
// Preloaded (node --require) by cli-report.test.js so the REAL src/cli.js can run end to end with no Zoom and no network:
//  - the clock is fixed at 09:20 in Jamaica (and keeps moving), and today's list holds one interview at 09:30
//  - the Zoom driver is a pretend one; FAKE_SCENARIO = ok | stuck | error
//  - fetch is replaced: it prints the report it would have sent as a line starting with "REPORT "
const Module = require('module')
const path = require('path')

const RealDate = Date
const offset = RealDate.UTC(2026, 9, 29, 14, 20, 0) - RealDate.now()
class FakeDate extends RealDate {
  constructor(...a) { a.length ? super(...a) : super(RealDate.now() + offset) }
  static now() { return RealDate.now() + offset }
}
globalThis.Date = FakeDate

const PAGE = 'Today\n09:30 AM - 10:00 AM\nBea Example Admin Assistant Interview\nMeeting ID: 111 000 0003\nStart\nChat'
const scenario = process.env.FAKE_SCENARIO || 'ok'
const { parseUpcoming } = require(path.join(__dirname, '..', '..', '..', 'src', 'upcoming.js'))

class FakeDriver {
  constructor() { this.started = false; this.transferred = false }
  async listUpcoming() {
    if (scenario === 'error') throw new Error("Zoom's Upcoming meetings page did not load.")
    return parseUpcoming(PAGE)
  }
  async join() { this.started = true; return { meetingId: '1110000003', link: '' } }
  async people() {
    const me = { userId: 'Bot#1', userName: 'Bot', isMe: true, isHost: !this.transferred, waiting: false }
    if (scenario === 'stuck') return [me]
    return [me, { userId: 'Kemal Example#1', userName: 'Kemal Example', isMe: false, isHost: this.transferred, waiting: false }]
  }
  async admit() {}
  async makeHost() { this.transferred = true }
  async leave() {}
  async close() {}
  async shot() { return '' }
}

const file = path.join(__dirname, '..', '..', '..', 'src', 'browserDriver.js')
const fake = new Module(file)
fake.filename = file
fake.exports = { ZoomBrowserDriver: FakeDriver }
fake.loaded = true
Module._cache[file] = fake

globalThis.fetch = async (url, init) => {
  process.stdout.write(`REPORT ${JSON.stringify({ url, redirect: init.redirect, body: JSON.parse(init.body) })}\n`)
  return { ok: true, status: 200 }
}
