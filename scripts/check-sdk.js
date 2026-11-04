'use strict'
// "npm run check:sdk": does Zoom's Meeting SDK page load and start up in this computer's Chrome? Needs NO Zoom credentials and
// does not touch Zoom's servers beyond downloading the SDK files. Prints the page's state; exit code 0 only if it is ready.
const puppeteer = require('puppeteer-core')
const { findChrome } = require('../src/config')
const { startPageServer, SDK_VERSION } = require('../src/sdkPage')

;(async () => {
  const ci = !!(process.env.CI || process.env.GITHUB_ACTIONS)
  const server = await startPageServer()
  const browser = await puppeteer.launch({
    executablePath: findChrome((process.env.CHROME_PATH || '').trim()),
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-first-run', ...(ci ? ['--no-sandbox', '--disable-dev-shm-usage'] : [])],
  })
  let code = 1
  try {
    const page = (await browser.pages())[0] || (await browser.newPage())
    const problems = []
    page.on('pageerror', (e) => problems.push(String(e.message).slice(0, 160)))
    page.on('requestfailed', (r) => problems.push(`failed to load ${new URL(r.url()).pathname.split('/').slice(-1)[0]}`))
    // no signature: the page only initialises the SDK and reports "initialized"
    await page.evaluateOnNewDocument((p) => { window.__BOT = p }, { version: SDK_VERSION })
    await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    const status = await page
      .waitForFunction(() => { const s = window.__BOT_STATUS; return s && s.state !== 'loading' ? s : false }, { timeout: 90000 })
      .then((h) => h.jsonValue())
      .catch(() => null)
    console.log(`Zoom Meeting SDK ${SDK_VERSION}: ${status ? status.state + (status.detail ? ` (${status.detail})` : '') : 'did not answer in 90 seconds'}`)
    if (problems.length) console.log(`Notes: ${[...new Set(problems)].slice(0, 5).join('; ')}`)
    code = status && status.state === 'initialized' ? 0 : 1
  } finally {
    await browser.close().catch(() => {})
    await server.close().catch(() => {})
  }
  process.exit(code)
})().catch((e) => { console.error('ERR', String(e.message).slice(0, 300)); process.exit(1) })
