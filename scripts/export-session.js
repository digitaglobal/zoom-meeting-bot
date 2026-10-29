#!/usr/bin/env node
'use strict'
// Packs the Zoom login this computer already has (the bot's .profile folder) into ONE text value, so a cloud run
// can use it without ever typing a password. The value is copied to the clipboard and also saved in
// ~/.zoom-meeting-bot/session.b64 (outside the project). It is a credential: paste it into the GitHub secret
// ZOOM_SESSION and nowhere else, then delete the file.
// Nothing is printed except counts and dates.
//
//   npm run export-session
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const puppeteer = require('puppeteer-core')
const { loadEnvFiles, loadConfig, findChrome } = require('../src/config')
const { encodeSession, describeSession, isZoomCookie } = require('../src/session')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function toClipboard(text) {
  const tries = process.platform === 'win32' ? [['clip', []]] : process.platform === 'darwin' ? [['pbcopy', []]] : [['xclip', ['-selection', 'clipboard']], ['wl-copy', []]]
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { input: text })
    if (!r.error && r.status === 0) return true
  }
  return false
}

;(async () => {
  loadEnvFiles()
  const cfg = loadConfig(process.env)
  const browser = await puppeteer.launch({
    executablePath: findChrome(cfg.chromePath),
    headless: true,
    userDataDir: cfg.profileDir,
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
  })
  try {
    const page = (await browser.pages())[0] || (await browser.newPage())
    // visit the pages the cloud run will use, so every cookie they need is fresh
    for (const url of ['https://app.zoom.us/wc/home', 'https://zoom.us/meeting#/upcoming']) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await sleep(4000)
    }
    const text = await page.evaluate(() => (document.body ? document.body.innerText : ''))
    if (/signin/.test(page.url()) || !/\bUpcoming\b/.test(text)) {
      throw new Error('The bot is not signed in to Zoom on this computer. Run "npm start -- --headed" once, sign in, then try again.')
    }
    const client = await page.createCDPSession()
    const { cookies } = await client.send('Network.getAllCookies')
    const zoom = cookies.filter(isZoomCookie)
    const encoded = encodeSession(zoom)
    // Kept in the user's home folder, NOT in the project (the project folder may be synced to OneDrive or committed).
    const dir = path.join(os.homedir(), '.zoom-meeting-bot')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'session.b64')
    fs.writeFileSync(file, encoded, { mode: 0o600 })
    const info = describeSession(zoom)
    console.log(`Saved the Zoom login: ${info.count} cookies, ${(encoded.length / 1024).toFixed(1)} KB (GitHub's limit is 48 KB).`)
    if (info.soonestExpiry) console.log(`The first of them expires on ${info.soonestExpiry.toISOString().slice(0, 10)}; the last on ${info.latestExpiry.toISOString().slice(0, 10)}.`)
    if (process.argv.includes('--no-clipboard')) console.log(`Not copied to the clipboard (--no-clipboard). It is in ${file}.`)
    else console.log(toClipboard(encoded) ? 'It is on your clipboard now: paste it into the GitHub secret ZOOM_SESSION.' : `Could not use the clipboard. Open ${file} and copy its contents.`)
    console.log('Treat it like a password. Do not paste it in chat, email or a file you commit.')
  } finally {
    await browser.close()
  }
})().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1) })
