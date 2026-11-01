'use strict'
// Drives Zoom's own web app in a real Chrome window, the way a person would. Every selector and button name
// below was read from the live Zoom screens (app.zoom.us/wc). If Zoom changes its page, this is the one file to fix.
//
// Never done here, on purpose: ending the meeting for everyone, or leaving while still the host.
const fs = require('fs')
const path = require('path')
const puppeteer = require('puppeteer-core')
const { findChrome } = require('./config')
const { toCookieParams } = require('./session')
const { parseUpcoming } = require('./upcoming')

const HOME = 'https://app.zoom.us/wc/home'
const UPCOMING = 'https://zoom.us/meeting#/upcoming'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const signInError = (msg) => Object.assign(new Error(msg), { code: 'SIGNIN_FAILED' })

class ZoomBrowserDriver {
  constructor(cfg, log = () => {}) {
    this.cfg = cfg
    this.log = log
    this.browser = null
    this.page = null
    this.frame = null
    this.started = false
    this.prepared = false
    this.forceVisible = false // set when a hidden browser could not sign in
  }

  // ---------- browser ----------
  async launch() {
    fs.mkdirSync(this.cfg.profileDir, { recursive: true })
    const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-first-run', '--disable-blink-features=AutomationControlled']
    if (this.cfg.ci) args.push('--no-sandbox', '--disable-dev-shm-usage') // a throwaway cloud machine
    // Chrome is started without the login in ITS environment, as a precaution. (This process still holds it, and on the cloud
    // Chrome runs without its sandbox, so a Chrome exploit delivered through Zoom's own pages is the residual risk.)
    const env = { ...process.env }
    for (const k of ['ZOOM_SESSION', 'ZOOM_PASSWORD', 'ZOOM_USERNAME', 'REPORT_WEBHOOK_URL']) delete env[k]
    this.browser = await puppeteer.launch({
      executablePath: findChrome(this.cfg.chromePath),
      env,
      headless: !(this.cfg.headed || this.forceVisible),
      userDataDir: this.cfg.profileDir, // keeps the Zoom sign-in between runs
      defaultViewport: { width: 1280, height: 900 },
      args,
    })
    this.page = (await this.browser.pages())[0] || (await this.browser.newPage())
    // A saved session (cloud runs) is handed to Chrome as cookies. It is never logged.
    if (this.cfg.session && this.cfg.session.length) {
      const client = await this.page.createCDPSession()
      try { await client.send('Network.setCookies', { cookies: toCookieParams(this.cfg.session) }) } finally { await client.detach().catch(() => {}) }
      this.log('Loaded the saved Zoom session.')
    }
  }

  async shot(name) {
    if (this.cfg.ci) return null // a cloud run never writes screenshots: they could show people's names
    try {
      fs.mkdirSync(this.cfg.screenshotDir, { recursive: true })
      const file = path.join(this.cfg.screenshotDir, `${name}-${Date.now()}.png`)
      await this.page.screenshot({ path: file })
      return file
    } catch { return null }
  }

  async close() {
    try { if (this.browser) await this.browser.close() } catch { /* already gone */ }
    this.browser = null
  }

  // ---------- sign in ----------
  async ensureSignedIn() {
    const page = this.page
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 })
    const state = await page
      .waitForFunction(() => {
        const buttons = [...document.querySelectorAll('button,a,[role=button]')]
        if (buttons.some((e) => /^new meeting$/i.test((e.getAttribute('aria-label') || e.textContent || '').trim()))) return 'in'
        if (document.querySelector('#email')) return 'out'
        // a signed-out visitor sees a landing page with a "Sign In" button instead of the form
        if (buttons.some((e) => /^sign in$/i.test((e.textContent || '').trim()))) return 'out'
        return false
      }, { timeout: 45000 })
      .then((h) => h.jsonValue())
      .catch(() => null)
    if (state === 'in') { this.log('Already signed in to Zoom.'); return }
    if (state !== 'out') { await this.shot('signin-unknown'); throw new Error('Zoom did not show either the home screen or the sign-in form.') }

    if (!this.cfg.canSignInWithPassword) {
      throw signInError('Zoom is not signed in and there is no password to sign in with. The saved session has probably expired: create it again with "npm run export-session".')
    }
    this.log('Signing in to Zoom...')
    if (!/signin/.test(page.url())) await page.goto('https://zoom.us/signin', { waitUntil: 'domcontentloaded', timeout: 60000 })
    try { await page.click('#onetrust-accept-btn-handler', { delay: 30 }) } catch { /* no cookie banner */ }
    await page.waitForSelector('#email', { visible: true, timeout: 20000 })
    await page.click('#email')
    await page.type('#email', this.cfg.username, { delay: 30 })
    await page.keyboard.press('Enter')
    try {
      await page.waitForSelector('input[name=password]', { visible: true, timeout: 20000 })
    } catch {
      await this.shot('signin-no-password')
      throw signInError('Zoom did not ask for a password (it may want a captcha, SSO or a code). Run once with HEADED=1 and sign in by hand; the bot remembers it.')
    }
    await page.type('input[name=password]', this.cfg.password, { delay: 30 })
    await sleep(600)
    // click the real button (more reliable than Enter in a hidden browser); fall back to Enter
    const clicked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent !== null && /^sign in$/i.test((x.textContent || '').trim()))
      if (b) { b.click(); return true }
      return false
    })
    if (!clicked) await page.keyboard.press('Enter')
    try {
      await page.waitForFunction(() => !/signin/.test(location.href), { timeout: 40000 })
    } catch {
      await this.shot('signin-failed')
      throw signInError('Zoom sign-in did not complete (wrong password, a captcha, or a verification code). Check the screenshot in the screenshots folder.')
    }
    await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 })
  }

  // ---------- the meeting frame ----------
  // The meeting runs inside a frame that contains the bottom toolbar; find it by that.
  async meetingFrame(timeoutMs = 20000) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      for (const f of this.page.frames()) {
        try {
          if (await f.evaluate(() => !!document.querySelector('.footer-button-base__button'))) { this.frame = f; return f }
        } catch { /* frame not ready */ }
      }
      await sleep(1000)
    }
    throw new Error('The Zoom meeting screen did not appear.')
  }

  async inMeeting(fn, ...args) {
    if (!this.frame) await this.meetingFrame()
    try {
      return await this.frame.evaluate(fn, ...args)
    } catch {
      await this.meetingFrame()
      return this.frame.evaluate(fn, ...args)
    }
  }

  async dismissPopups() {
    await this.inMeeting(() => {
      for (const label of ['OK', 'Got it']) {
        for (const b of document.querySelectorAll('button')) if (b.offsetParent !== null && (b.textContent || '').trim() === label) b.click()
      }
    })
  }

  // ---------- start ----------
  // Opens the browser and makes sure Zoom is signed in (once per run).
  async prepare() {
    if (this.prepared) return
    await this.launch()
    try {
      await this.ensureSignedIn()
    } catch (e) {
      // A cloud run has no screen, so it cannot do the visible sign-in below.
      if (e.code !== 'SIGNIN_FAILED' || this.cfg.headed || this.cfg.ci) throw e
      // Zoom's sign-in captcha rejects a hidden browser. Sign in once in a visible window (the session is saved in
      // the profile folder), then carry on hidden.
      this.log('Zoom did not accept a hidden sign-in. Opening a visible window once to sign in...')
      await this.close()
      this.forceVisible = true
      await this.launch()
      await this.ensureSignedIn()
      await sleep(3000) // let the browser save the session before closing
      await this.close()
      this.forceVisible = false
      await this.launch()
      await this.ensureSignedIn()
    }
    this.prepared = true
  }

  // Zoom's "Upcoming meetings" list for today: [{ start, end, title, id, buttons }]. See upcoming.js.
  async listUpcoming() {
    await this.prepare()
    const page = this.page
    await page.goto(UPCOMING, { waitUntil: 'domcontentloaded', timeout: 60000 })
    // the list fills in after the page loads: wait until the text stops changing
    let last = ''
    let same = 0
    const end = Date.now() + 30000
    while (Date.now() < end) {
      const text = await page.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '')
      if (/\bUpcoming\b/.test(text) && text === last) { if (++same >= 3) break } else same = 0
      last = text
      await sleep(1000)
    }
    if (/signin/.test(page.url())) throw signInError('Zoom sent the bot to the sign-in page, so the saved session has expired.')
    if (!/\bUpcoming\b/.test(last)) { await this.shot('upcoming-not-loaded'); throw new Error('Zoom\'s Upcoming meetings page did not load.') }
    return parseUpcoming(last)
  }

  // Starts a meeting as host: a brand-new one, or (start.meetingId) one that is already on the schedule.
  async join(start = {}) {
    await this.prepare()
    const page = this.page
    if (start.meetingId) {
      if (!/^\d{9,11}$/.test(String(start.meetingId))) throw new Error('That is not a Zoom meeting number.')
      this.log('Starting the scheduled meeting...')
      await page.goto(`https://app.zoom.us/wc/${start.meetingId}/start`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    } else {
      await page.goto(HOME, { waitUntil: 'domcontentloaded', timeout: 60000 })
      this.log('Starting a new meeting...')
      await page.waitForFunction(() => [...document.querySelectorAll('button,a,[role=button]')].some((e) => /^new meeting$/i.test((e.getAttribute('aria-label') || e.textContent || '').trim())), { timeout: 30000 })
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button,a,[role=button]')].find((e) => /^new meeting$/i.test((e.getAttribute('aria-label') || e.textContent || '').trim()))
        if (b) b.click()
      })
    }
    // Zoom may ask "Join in Zoom Workplace app?": answer "Join in browser"
    const next = await page
      .waitForFunction(() => {
        const dlg = [...document.querySelectorAll('button')].find((b) => /^join in browser$/i.test((b.textContent || '').trim()))
        if (dlg) return 'dialog'
        return /\/wc\/\d+\/start/.test(location.href) ? 'started' : false
      }, { timeout: 30000 })
      .then((h) => h.jsonValue())
      .catch(() => null)
    if (next === 'dialog') {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /^join in browser$/i.test((x.textContent || '').trim()))
        if (b) b.click()
      })
    } else if (next !== 'started') {
      await this.shot('start-failed')
      throw new Error('Zoom did not start the meeting.')
    }
    await this.meetingFrame(90000)
    this.started = true
    const meetingId = (/\/wc\/(\d+)\//.exec(page.url()) || [])[1] || ''
    await sleep(1500)
    await this.dismissPopups()
    const link = await this.readInviteLink(meetingId)
    return { meetingId, link }
  }

  async readInviteLink(meetingId) {
    const fallback = meetingId ? `https://zoom.us/j/${meetingId}` : ''
    try {
      await this.inMeeting(() => {
        const b = [...document.querySelectorAll('button')].find((e) => /^meeting information$/i.test((e.getAttribute('aria-label') || '').trim()))
        if (b) b.click()
      })
      await sleep(1200)
      const text = await this.inMeeting(() => {
        const ta = document.querySelector('textarea.hideme')
        return ta ? ta.value || ta.textContent || '' : ''
      })
      await this.page.keyboard.press('Escape')
      const m = /https:\/\/[a-z0-9.]*zoom\.us\/j\/\d+\S*/i.exec(text)
      return m ? m[0] : fallback
    } catch {
      return fallback
    }
  }

  // a person's display name for messages; a cloud (public) log says "that person" instead
  who(userId) { return this.cfg.quiet ? 'that person' : userId.slice(0, userId.lastIndexOf('#')) }

  // ---------- the participants panel ----------
  async openParticipants() {
    const hasRows = () => this.inMeeting(() => !!document.querySelector('.participants-item-position'))
    if (await hasRows()) return
    await this.inMeeting(() => {
      const b = [...document.querySelectorAll('button')].find((e) => /^open/i.test(e.getAttribute('aria-label') || '') && /participants list pane/i.test(e.getAttribute('aria-label') || ''))
      if (b) b.click()
    })
    const end = Date.now() + 8000
    while (Date.now() < end) { if (await hasRows()) return; await sleep(400) }
    throw new Error('Could not open the participants list.')
  }

  // [{ userId, userName, isMe, isHost, waiting }]. userId is "name#n" (Zoom does not show real ids).
  async people() {
    await this.openParticipants()
    return this.inMeeting(() => {
      const seen = {}
      return [...document.querySelectorAll('.participants-item-position')].map((r) => {
        const name = ((r.querySelector('.participants-item__display-name') || {}).textContent || '').trim()
        const label = ((r.querySelector('.participants-item__name-label') || {}).textContent || '').trim()
        const buttons = [...r.querySelectorAll('button')].map((b) => (b.getAttribute('aria-label') || b.textContent || '').trim())
        seen[name] = (seen[name] || 0) + 1
        return {
          userId: `${name}#${seen[name]}`,
          userName: name,
          label,
          waiting: buttons.some((t) => /^admit$/i.test(t)),
          isMe: /\bme\b/i.test(label),
          isHost: /\bhost\b/i.test(label) && !/co-?host/i.test(label),
        }
      })
    })
  }

  async admit(userId) {
    await this.openParticipants()
    const ok = await this.inMeeting((id) => {
      const at = id.lastIndexOf('#')
      const name = id.slice(0, at)
      const n = Number(id.slice(at + 1))
      const rows = [...document.querySelectorAll('.participants-item-position')].filter((r) => ((r.querySelector('.participants-item__display-name') || {}).textContent || '').trim() === name)
      const row = rows[n - 1]
      const btn = row && [...row.querySelectorAll('button')].find((b) => /^admit$/i.test((b.textContent || '').trim()))
      if (btn) { btn.click(); return true }
      return false
    }, userId)
    if (!ok) throw new Error(`Could not find an Admit button for ${this.who(userId)}.`)
  }

  async makeHost(userId) {
    await this.openParticipants()
    const name = userId.slice(0, userId.lastIndexOf('#'))
    const opened = await this.inMeeting((id) => {
      const at = id.lastIndexOf('#')
      const nm = id.slice(0, at)
      const n = Number(id.slice(at + 1))
      const rows = [...document.querySelectorAll('.participants-item-position')].filter((r) => ((r.querySelector('.participants-item__display-name') || {}).textContent || '').trim() === nm)
      const row = rows[n - 1]
      const btn = row && [...row.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'More options')
      if (btn) { btn.click(); return true }
      return false
    }, userId)
    if (!opened) throw new Error(`Could not open the menu for ${this.who(userId)}.`)
    await sleep(900)
    const picked = await this.inMeeting(() => {
      const item = [...document.querySelectorAll('[role=menuitem],.dropdown-menu a,.dropdown-menu li a')].find((e) => /^make host$/i.test((e.textContent || '').trim()))
      if (item) { item.click(); return true }
      return false
    })
    if (!picked) { await this.page.keyboard.press('Escape'); throw new Error('Zoom did not offer "Make Host" for that person.') }
    // Confirm ONLY if the dialog names the intended person.
    const end = Date.now() + 10000
    while (Date.now() < end) {
      const clicked = await this.inMeeting((nm) => {
        // Read ONLY the confirmation dialog: the smallest block around the Yes button that holds the question.
        // (Never the whole page, where a participant's name or a chat line could imitate it.)
        const yes = [...document.querySelectorAll('button')].find((b) => b.offsetParent !== null && (b.textContent || '').trim() === 'Yes')
        if (!yes) return 'waiting'
        let box = yes.parentElement
        for (let i = 0; i < 8 && box && !/change the host to/i.test(box.innerText || ''); i++) box = box.parentElement
        if (!box) return 'waiting'
        // the dialog must name EXACTLY the intended person ("Kemal" is not enough for "Kemal Example"); no looser fallback
        const named = /change the host to ([^?]{1,120})\?/.exec(box.innerText.replace(/\s+/g, ' '))
        if (!named || named[1].trim() !== nm) return 'waiting'
        yes.click()
        return 'clicked'
      }, name)
      if (clicked === 'clicked') return
      await sleep(400)
    }
    await this.shot('makehost-no-dialog')
    throw new Error(`Zoom's confirmation for making ${this.who(userId)} the host did not appear.`)
  }

  // ---------- leave (never end) ----------
  async leave() {
    // Defence in depth: refuse unless Zoom shows that the bot is no longer the host.
    const me = (await this.people()).find((p) => p.isMe)
    if (!me || me.isHost) throw new Error('Refusing to leave: the bot is still the host.')
    await this.inMeeting(() => {
      const b = [...document.querySelectorAll('.footer-button-base__button')].find((e) => /^leave$/i.test((e.textContent || '').trim()))
      if (b) b.click()
    })
    const end = Date.now() + 8000
    let clicked = false
    while (Date.now() < end && !clicked) {
      await sleep(400)
      clicked = await this.inMeeting(() => {
        const b = [...document.querySelectorAll('button')].find((e) => e.offsetParent !== null && (e.textContent || '').trim() === 'Leave Meeting')
        if (b) { b.click(); return true }
        return false
      })
    }
    if (!clicked) throw new Error('Zoom did not show a plain "Leave Meeting" button, so the bot did not leave.')
    const gone = Date.now() + 20000
    while (Date.now() < gone) {
      if (!/\/wc\/\d+\/start/.test(this.page.url())) return
      await sleep(500)
    }
  }
}

module.exports = { ZoomBrowserDriver }
