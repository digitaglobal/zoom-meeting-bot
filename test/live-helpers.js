'use strict'
// Shared by the live tests: a fake "Kemal" guest in a second browser, and test-only cleanup that ends the test
// meeting for everyone. The bot itself (src/) can never do the second one.
const puppeteer = require('puppeteer-core')
const { findChrome } = require('../src/config')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toLocaleTimeString('en-US', { hour12: false })
const log = (m) => console.log(`[${stamp()}] ${m}`)
const GUEST_NAME = 'Kemal-Test'

async function guestJoin(cfg, meetingId, headless, profileDir) {
  const browser = await puppeteer.launch({
    executablePath: findChrome(cfg.chromePath),
    headless,
    userDataDir: profileDir,
    defaultViewport: { width: 1100, height: 800 },
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-first-run', '--disable-blink-features=AutomationControlled'],
  })
  const page = (await browser.pages())[0] || (await browser.newPage())
  await page.goto(`https://app.zoom.us/wc/join/${meetingId}`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await page.waitForSelector('#input-for-name', { visible: true, timeout: 30000 })
  await page.click('#input-for-name', { clickCount: 3 })
  await page.keyboard.press('Backspace')
  await page.type('#input-for-name', GUEST_NAME, { delay: 30 })
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((e) => /^join$/i.test((e.textContent || '').trim()))
    if (b) b.click()
  })
  log(`Guest "${GUEST_NAME}" is joining (it will wait in the waiting room until the bot lets it in).`)
  return { browser, page }
}

async function isHostNow(page) {
  return page.evaluate(() => [...document.querySelectorAll('button')].some((b) => /^host tools$/i.test((b.getAttribute('aria-label') || b.textContent || '').trim())))
}

// Test-harness cleanup only: ends the meeting for everyone, from whichever page is currently the host.
async function endMeetingFrom(page) {
  for (const f of page.frames()) {
    try {
      const has = await f.evaluate(() => !!document.querySelector('.footer-button-base__button'))
      if (!has) continue
      await f.evaluate(() => { for (const t of ['OK', 'Got it']) for (const b of document.querySelectorAll('button')) if (b.offsetParent !== null && (b.textContent || '').trim() === t) b.click() })
      await sleep(500)
      await f.evaluate(() => { const b = [...document.querySelectorAll('.footer-button-base__button')].find((e) => /^(end|leave)$/i.test((e.textContent || '').trim())); if (b) b.click() })
      await sleep(1200)
      const ended = await f.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((e) => e.offsetParent !== null && /^end meeting for all$/i.test((e.textContent || '').trim()))
        if (b) { b.click(); return true }
        return false
      })
      if (ended) { await sleep(2500); return true }
    } catch { /* frame gone */ }
  }
  return false
}

// Live tests start real meetings on the real account, so they must never run while a real one is in progress.
async function refuseIfAnythingRunning(cfg) {
  const { ZoomBrowserDriver } = require('../src/browserDriver')
  const d = new ZoomBrowserDriver(cfg, () => {})
  let list
  try { list = await d.listUpcoming() } finally { await d.close() }
  const running = list.filter((m) => m.buttons.includes('End') || m.buttons.includes('Join'))
  if (running.length) { console.log(`REFUSING to run: ${running.length} meeting(s) on the account are in progress.`); process.exit(2) }
  return list
}

module.exports = { sleep, log, GUEST_NAME, guestJoin, isHostNow, endMeetingFrom, refuseIfAnythingRunning }
