'use strict'
// The permanent way in: no Zoom login at all. The meeting list comes from Zoom's API (zoomApi.js) and a meeting is started
// as host through Zoom's Meeting SDK with a fresh host start key (sdkPage.js), in the bot's own Chrome. From there the
// meeting screen is the same one the browser driver already knows, so people / admit / makeHost / leave are inherited.
//
// Same small interface as ZoomBrowserDriver (see handover.js), so the hand-over rules and their tests do not change.
const { ZoomBrowserDriver } = require('./browserDriver')
const { makeSdkSignature } = require('./sdkSignature')
const { startPageServer, SDK_VERSION } = require('./sdkPage')
const { safeText } = require('./zoomApi')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BOT_NAME = 'Meeting host bot'

class ZoomSdkDriver extends ZoomBrowserDriver {
  constructor(cfg, api, log = () => {}) {
    super(cfg, log)
    this.api = api
    this.server = null
  }

  // There is no sign-in step: opening the browser is all that is needed.
  async prepare() {
    if (this.prepared) return
    await this.launch()
    this.prepared = true
  }

  // Straight from Zoom's API: a run with nothing due never even opens a browser.
  async listUpcoming() {
    return this.api.upcomingRows(this.cfg.timeZone)
  }

  // For the hourly dry-run login check: proves the credentials and every permission, starts nothing.
  async verify() {
    return this.api.verify(this.cfg.timeZone)
  }

  async join(start = {}) {
    const meetingId = String(start.meetingId || '')
    if (!meetingId) throw new Error('Without a Zoom login the bot can only start a meeting that is on the schedule: give its meeting number.')
    if (!/^\d{9,11}$/.test(meetingId)) throw new Error('That is not a Zoom meeting number.')
    this.log('Starting the scheduled meeting...')
    const zak = await this.api.zak()
    const signature = makeSdkSignature({ sdkKey: this.cfg.api.sdkKey, sdkSecret: this.cfg.api.sdkSecret, meetingNumber: meetingId, role: 1 })
    this.api.mask(zak)
    this.api.mask(signature)
    await this.prepare()
    this.server = await startPageServer()
    // The page gets its settings from Chrome's devtools connection, so nothing secret is ever in an address or a log.
    await this.page.evaluateOnNewDocument((p) => { window.__BOT = p }, { version: SDK_VERSION, signature, sdkKey: this.cfg.api.sdkKey, meetingNumber: meetingId, userName: BOT_NAME, zak })
    await this.page.goto(this.server.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    const status = await this.page
      .waitForFunction(() => { const s = window.__BOT_STATUS; return s && (s.state === 'joined' || s.state === 'error') ? s : false }, { timeout: 120000 })
      .then((h) => h.jsonValue())
      .catch(() => null)
    if (!status || status.state !== 'joined') {
      // The page's report can lag or be wrong, but the meeting screen cannot: if it is up, the meeting IS running with the bot
      // as host, and closing the browser now would leave it hostless. Look before giving up.
      const up = await this.meetingFrame(10000).then(() => true, () => false)
      if (!up) {
        await this.shot('start-failed')
        throw new Error(`Zoom did not start the meeting${status && status.detail ? ` (${safeText(status.detail)})` : ''}.`)
      }
      this.log('Zoom\'s meeting screen is up although the page did not report it; carrying on.')
    }
    // From here the meeting is live and the bot is its host: an error must leave the bot in it, never drop out hostless.
    this.started = true
    await this.meetingFrame(90000)
    await sleep(1500)
    await this.dismissPopups()
    return { meetingId, link: `https://zoom.us/j/${meetingId}` }
  }

  // The inherited leave() waits for the web app's address to change, which never happens here: wait for the SDK's own "left" page,
  // so the browser is not closed in the middle of leaving. (It still refuses to leave unless the bot is no longer the host.)
  async leave() {
    await super.leave()
    const end = Date.now() + 20000
    while (Date.now() < end) {
      let url = ''
      try { url = this.page.url() } catch { return }
      if (/\/left(\?|#|$)/.test(url)) return
      await sleep(500)
    }
  }

  async close() {
    await super.close()
    if (this.server) { await this.server.close().catch(() => {}); this.server = null }
  }
}

module.exports = { ZoomSdkDriver, BOT_NAME }
