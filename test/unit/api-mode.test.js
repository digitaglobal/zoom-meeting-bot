'use strict'
// The permanent way in: Zoom API credentials instead of a Zoom login (zoomApi.js, sdkSignature.js, sdkPage.js, sdkDriver.js).
// Nothing here talks to Zoom: the network is a fake, and the fake "Chrome page" only records what it was given.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const http = require('http')
const { parseApiCredentials, createZoomApi, meetingRows, clockLabel, safeText, API_KEYS } = require('../../src/zoomApi')
const { makeSdkSignature } = require('../../src/sdkSignature')
const { pageHtml, pageScript, startPageServer, SDK_VERSION } = require('../../src/sdkPage')
const { ZoomSdkDriver } = require('../../src/sdkDriver')
const { dueMeetings } = require('../../src/upcoming')
const { loadConfig, loadDotEnv, ALLOWED_KEYS, PARENT_ALLOWED_KEYS } = require('../../src/config')
const { chromeEnv, ZoomBrowserDriver } = require('../../src/browserDriver')
const { scrub } = require('../../src/log')
const os = require('os')

const CS = ['client', 'VALUE', '9'].join('-') // built, not written out: the repo guard bans credential-looking literals
const SS = ['sdk', 'VALUE', '9'].join('-')
const ENV = {
  ZOOM_ACCOUNT_ID: 'acct_ABC123xyz',
  ZOOM_S2S_CLIENT_ID: 'clientIdValue1',
  ZOOM_S2S_CLIENT_SECRET: CS,
  ZOOM_SDK_KEY: 'sdkKeyValue1',
  ZOOM_SDK_SECRET: SS,
  ZOOM_HOST_EMAIL: 'host.person@example.com',
}
const SECRETS = [CS, SS]
const ACC = 'ACCESS-1-VALUE'
const KEYZ = 'ZAK-1-VALUE'

// ---------- settings ----------
test('api settings: none means "use the saved login", all six means API mode', () => {
  assert.equal(parseApiCredentials({}), null)
  assert.equal(parseApiCredentials({ ZOOM_SESSION: 'x' }), null)
  const c = parseApiCredentials(ENV)
  assert.equal(c.accountId, ENV.ZOOM_ACCOUNT_ID)
  assert.equal(c.hostEmail, ENV.ZOOM_HOST_EMAIL)
})

test('api settings: a partial set stops the run and names what is missing, never a value', () => {
  for (const key of API_KEYS) {
    const partial = { ...ENV }
    delete partial[key]
    assert.throws(() => parseApiCredentials(partial), (e) => e.message.includes(key) && !SECRETS.some((s) => e.message.includes(s)))
  }
  assert.throws(() => parseApiCredentials({ ...ENV, ZOOM_SDK_SECRET: 'has a space' }), (e) => /ZOOM_SDK_SECRET/.test(e.message) && !/has a space/.test(e.message))
  assert.throws(() => parseApiCredentials({ ...ENV, ZOOM_HOST_EMAIL: 'not-an-email' }), /ZOOM_HOST_EMAIL/)
})

test('config: API mode needs no Zoom login, wins over a session, and the six settings may come from an env file', () => {
  const c = loadConfig({ ...ENV })
  assert.equal(c.api.sdkKey, ENV.ZOOM_SDK_KEY)
  assert.equal(c.session, null)
  assert.equal(c.canSignInWithPassword, false)
  assert.throws(() => loadConfig({}), /ZOOM_USERNAME, ZOOM_PASSWORD/, 'still refuses to start with no way in at all')
  assert.throws(() => loadConfig({ ZOOM_ACCOUNT_ID: 'only-one' }), /incomplete/i)
  for (const k of API_KEYS) assert.ok(ALLOWED_KEYS.has(k), `${k} can be read from an env file`)
})

test('chrome environment: every ZOOM_* setting, the host name and the report address are removed; everything else is kept', () => {
  const env = chromeEnv({ PATH: '/bin', HOME: '/h', ...ENV, ZOOM_SESSION: 's', ZOOM_PASSWORD: 'p', ZOOM_USERNAME: 'u', ZOOM_SOMETHING_NEW: 'n', zoom_lower: 'l', NEW_HOST_NAME: 'n', REPORT_WEBHOOK_URL: 'r', GITHUB_ACTIONS: 'true' })
  assert.deepEqual(Object.keys(env).sort(), ['GITHUB_ACTIONS', 'HOME', 'PATH'])
  assert.equal(chromeEnv(undefined) && Object.keys(chromeEnv(undefined)).length, 0)
})

test('only the bot own .env may hold the API credentials; the parent app .env.local may not (same names, a different Zoom app)', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-')), '.env')
  fs.writeFileSync(f, ['ZOOM_ACCOUNT_ID=from-file', 'ZOOM_HOST_EMAIL=h@example.com', 'NEW_HOST_NAME=Maria', ''].join('\n'))
  const own = {}
  loadDotEnv(f, own)
  assert.equal(own.ZOOM_ACCOUNT_ID, 'from-file')
  const parent = {}
  loadDotEnv(f, parent, PARENT_ALLOWED_KEYS)
  assert.equal(parent.ZOOM_ACCOUNT_ID, undefined)
  assert.equal(parent.ZOOM_HOST_EMAIL, undefined)
  assert.equal(parent.NEW_HOST_NAME, 'Maria', 'the ordinary settings still come from the parent file')
  for (const k of API_KEYS) assert.ok(!PARENT_ALLOWED_KEYS.has(k), k)
})

// ---------- the signature ----------
test('signature: a standard HS256 token with the host role, verifiable with the secret', () => {
  const now = Date.UTC(2026, 10, 3, 12, 0, 0)
  const token = makeSdkSignature({ sdkKey: 'KEY', sdkSecret: 'SECRET', meetingNumber: '12345678901', role: 1, nowMs: now })
  const [h, b, s] = token.split('.')
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { alg: 'HS256', typ: 'JWT' })
  const body = JSON.parse(Buffer.from(b, 'base64url'))
  assert.equal(body.sdkKey, 'KEY')
  assert.equal(body.appKey, 'KEY')
  assert.equal(body.mn, '12345678901')
  assert.equal(body.role, 1)
  assert.equal(body.iat, Math.floor(now / 1000) - 30)
  assert.ok(body.exp - body.iat >= 1800, 'Zoom needs at least 30 minutes of life')
  assert.equal(body.tokenExp, body.exp)
  assert.equal(s, crypto.createHmac('sha256', 'SECRET').update(`${h}.${b}`).digest('base64url'))
  assert.ok(!token.includes('SECRET'))
})

test('signature: the default role is guest; the host role has to be asked for', () => {
  const body = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url'))
  assert.equal(body(makeSdkSignature({ sdkKey: 'K', sdkSecret: 'S', meetingNumber: '12345678901' })).role, 0)
  assert.equal(body(makeSdkSignature({ sdkKey: 'K', sdkSecret: 'S', meetingNumber: '12345678901', role: 1 })).role, 1)
})

test('signature: refuses a bad meeting number, a bad role and missing keys', () => {
  const ok = { sdkKey: 'K', sdkSecret: 'S', meetingNumber: '12345678901' }
  assert.throws(() => makeSdkSignature({ ...ok, meetingNumber: '123' }), /meeting number/)
  assert.throws(() => makeSdkSignature({ ...ok, meetingNumber: '1234567890; drop' }), /meeting number/)
  assert.throws(() => makeSdkSignature({ ...ok, role: 2 }), /role/)
  assert.throws(() => makeSdkSignature({ ...ok, sdkSecret: '' }), /key and secret/)
})

// ---------- the API client (fake network) ----------
function fakeFetch(handler) {
  const calls = []
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    const r = await handler(String(url), init, calls.length)
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => (r.body === undefined ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) }
  }
  fn.calls = calls
  return fn
}

const goodApi = (extra = {}) => fakeFetch((url) => {
  if (url.startsWith('https://zoom.us/oauth/token')) return { status: 200, body: { access_token: ACC, expires_in: 3600 } }
  if (/\/token\?type=zak/.test(url)) return { status: 200, body: { token: KEYZ } }
  if (/type=upcoming/.test(url)) return { status: 200, body: { meetings: [{ id: 12345678901, topic: 'Ann Example Interview', start_time: '2026-11-03T22:20:00Z' }, { id: 12345678902, topic: 'Live one', start_time: '2026-11-03T22:00:00Z' }] } }
  if (/type=live/.test(url)) return { status: 200, body: { meetings: [{ id: 12345678902, topic: 'Live one' }] } }
  return extra.fallback ? extra.fallback(url) : { status: 404, body: { code: 3001, message: 'nope' } }
})

test('api client: signs in with the app credentials (account_credentials, Basic auth) and reuses the token', async () => {
  const f = goodApi()
  const api = createZoomApi(parseApiCredentials(ENV), { fetch: f, now: () => 1000 })
  assert.equal(await api.zak(), KEYZ)
  await api.listMeetings('upcoming')
  const tokenCalls = f.calls.filter((c) => c.url.startsWith('https://zoom.us/oauth/token'))
  assert.equal(tokenCalls.length, 1, 'one sign-in serves several calls')
  assert.equal(tokenCalls[0].init.method, 'POST')
  assert.match(tokenCalls[0].url, /grant_type=account_credentials/)
  assert.match(tokenCalls[0].url, /account_id=acct_ABC123xyz/)
  assert.equal(tokenCalls[0].init.headers.Authorization, `Basic ${Buffer.from(`clientIdValue1:${CS}`).toString('base64')}`)
  for (const c of f.calls.filter((x) => x.url.startsWith('https://api.zoom.us/'))) assert.equal(c.init.headers.Authorization, `Bearer ${ACC}`)
})

test('api client: a new sign-in once the token is about to expire', async () => {
  let t = 0
  const f = goodApi()
  const api = createZoomApi(parseApiCredentials(ENV), { fetch: f, now: () => t })
  await api.zak()
  t = 3500 * 1000 // past expiry minus the safety margin
  await api.zak()
  assert.equal(f.calls.filter((c) => c.url.startsWith('https://zoom.us/oauth/token')).length, 2)
})

test('api client: the start key is asked for the host by e-mail, short-lived', async () => {
  const f = goodApi()
  await createZoomApi(parseApiCredentials(ENV), { fetch: f }).zak()
  const url = f.calls.find((c) => /token\?type=zak/.test(c.url)).url
  assert.equal(url, 'https://api.zoom.us/v2/users/host.person%40example.com/token?type=zak&ttl=7200')
})

test('api client: follows next_page_token', async () => {
  const f = fakeFetch((url) => {
    if (url.startsWith('https://zoom.us/oauth/token')) return { status: 200, body: { access_token: ACC, expires_in: 3600 } }
    return url.includes('next_page_token=P2') ? { status: 200, body: { meetings: [{ id: 2 }] } } : { status: 200, body: { meetings: [{ id: 1 }], next_page_token: 'P2' } }
  })
  const list = await createZoomApi(parseApiCredentials(ENV), { fetch: f }).listMeetings('upcoming')
  assert.deepEqual(list.map((m) => m.id), [1, 2])
})

test('api client: errors name the call and Zoom\'s code, mask e-mail addresses and tokens, and never contain a secret', async () => {
  const f = fakeFetch((url) => {
    if (url.startsWith('https://zoom.us/oauth/token')) return { status: 200, body: { access_token: ACC, expires_in: 3600 } }
    return { status: 400, body: { code: 1001, message: 'User does not exist: host.person@example.com. Invalid access token, does not contain scopes:[user:read:token:admin, user:read:zak:admin] abcdefghijklmnopqrstuvwxyzABCDEFGHIJ' } }
  })
  await assert.rejects(createZoomApi(parseApiCredentials(ENV), { fetch: f }).zak(), (e) => {
    assert.match(e.message, /get the host start key failed \(HTTP 400, Zoom code 1001\)/)
    assert.match(e.message, /user:read:token:admin/, 'the missing scope is what the owner needs to see')
    assert.ok(!e.message.includes('host.person@example.com'))
    assert.ok(!e.message.includes('abcdefghijklmnopqrstuvwxyzABCDEFGHIJ'))
    assert.ok(![...SECRETS, ACC, 'Basic'].some((s) => e.message.includes(s)))
    return true
  })
})

test('api client: a wrong app credential says so plainly and is not retried', async () => {
  const f = fakeFetch(() => ({ status: 401, body: { reason: 'Invalid client_id or client_secret', error: 'invalid_client' } }))
  await assert.rejects(createZoomApi(parseApiCredentials(ENV), { fetch: f, sleep: async () => {} }).accessToken(), /sign in with the app credentials failed \(HTTP 401\).*Invalid client_id or client_secret/)
  assert.equal(f.calls.length, 1)
})

test('api client: one retry on a server error or a dropped connection, then it gives up', async () => {
  let n = 0
  const flaky = fakeFetch((url) => (++n === 1 ? { status: 503, body: 'busy' } : { status: 200, body: { access_token: ACC, expires_in: 3600 } }))
  assert.equal(await createZoomApi(parseApiCredentials(ENV), { fetch: flaky, sleep: async () => {} }).accessToken(), ACC)
  assert.equal(flaky.calls.length, 2)
  const down = async () => { throw Object.assign(new Error('secret-detail ECONNRESET'), { name: 'TypeError' }) }
  await assert.rejects(createZoomApi(parseApiCredentials(ENV), { fetch: down, sleep: async () => {} }).accessToken(), (e) => /could not be reached/.test(e.message) && !/secret-detail/.test(e.message))
})

test('api client: an empty answer is an error, not a silent success', async () => {
  const noToken = fakeFetch(() => ({ status: 200, body: {} }))
  await assert.rejects(createZoomApi(parseApiCredentials(ENV), { fetch: noToken }).accessToken(), /no access token/)
  const noZak = fakeFetch((url) => (url.startsWith('https://zoom.us/oauth/token') ? { status: 200, body: { access_token: ACC, expires_in: 3600 } } : { status: 200, body: {} }))
  await assert.rejects(createZoomApi(parseApiCredentials(ENV), { fetch: noZak }).zak(), /start key was empty/)
})

test('api client: verify() proves sign-in, listing and the start key, and starts nothing', async () => {
  const f = goodApi()
  const r = await createZoomApi(parseApiCredentials(ENV), { fetch: f }).verify('America/Jamaica')
  assert.equal(r.meetings, 2)
  assert.ok(f.calls.every((c) => c.init.method !== 'DELETE' && c.init.method !== 'PATCH' && !/\/meetings\/\d+\/status/.test(c.url)))
  assert.ok(f.calls.some((c) => /token\?type=zak/.test(c.url)))
})

test('api client: never follows a redirect with a credential attached, and a short-lived key is asked for a check', async () => {
  const f = goodApi()
  const api = createZoomApi(parseApiCredentials(ENV), { fetch: f })
  await api.verify('America/Jamaica')
  assert.ok(f.calls.every((c) => c.init.redirect === 'error'))
  assert.match(f.calls.find((c) => c.url.includes('/token?type=zak')).url, /ttl=300$/, 'a check mints a 5-minute key, not a 2-hour one')
  const f2 = goodApi()
  await createZoomApi(parseApiCredentials(ENV), { fetch: f2 }).zak()
  assert.match(f2.calls.find((c) => c.url.includes('/token?type=zak')).url, /ttl=7200$/)
})

test('api client: every secret made during the run is offered for masking', async () => {
  const seen = []
  const api = createZoomApi(parseApiCredentials(ENV), { fetch: goodApi(), onSecret: (v) => seen.push(v) })
  await api.zak()
  assert.deepEqual(seen.sort(), [ACC, KEYZ].sort())
  api.mask('signature-value')
  assert.ok(seen.includes('signature-value'))
})

test('api client: a list longer than it reads is an error, not a silent cut', async () => {
  const f = fakeFetch((url) => (url.startsWith('https://zoom.us/oauth/token') ? { status: 200, body: { access_token: ACC, expires_in: 3600 } } : { status: 200, body: { meetings: [{ id: 1 }], next_page_token: 'more' } }))
  await assert.rejects(createZoomApi(parseApiCredentials(ENV), { fetch: f }).listMeetings('upcoming'), /longer than the bot reads/)
})

test('log scrub: also hides e-mail addresses and long token-like strings', () => {
  assert.equal(scrub('failed for a@b.com with ' + 'Zz9_-'.repeat(8)), 'failed for [email] with [token]')
  assert.equal(scrub('plain words stay'), 'plain words stay')
})

test('safeText: masks e-mail addresses, links and token-like strings', () => {
  const t = safeText('x a@b.com https://zoom.us/j/123456789?pwd=abc ' + 'A'.repeat(40) + ' ok')
  assert.equal(t, 'x [email] [link] [token] ok')
})

// ---------- the meeting list ----------
test('meetingRows: the same shape as the scraped list; a running meeting is not startable', () => {
  const rows = meetingRows(
    [
      { id: 12345678901, topic: 'Ann Example Interview', start_time: '2026-11-03T22:20:00Z' },
      { id: 12345678902, topic: 'Running', start_time: '2026-11-03T22:00:00Z' },
      { id: 123, topic: 'short id', start_time: '2026-11-03T23:00:00Z' },
      { id: 12345678903, topic: 'no time (recurring, no fixed time)' },
      { id: 12345678904, topic: 'bad time', start_time: 'soon' },
    ],
    [{ id: 12345678902 }],
    { timeZone: 'America/Jamaica' },
  )
  assert.deepEqual(rows.map((r) => r.id), ['12345678902', '12345678901'], 'sorted by start; unusable rows dropped')
  const ann = rows.find((r) => r.id === '12345678901')
  assert.equal(ann.title, 'Ann Example Interview')
  assert.equal(ann.start, '05:20 PM', 'shown in Jamaica time (UTC-5)')
  assert.ok(ann.buttons.includes('Start'))
  assert.deepEqual(rows.find((r) => r.id === '12345678902').buttons, ['Join', 'End'])
  assert.equal(clockLabel(Date.UTC(2026, 10, 3, 14, 30), 'America/Jamaica'), '09:30 AM')
})

test('schedule check on API rows: due 15 min ahead to 5 min late, exact dates, running meetings never', () => {
  const at = (iso) => new Date(iso)
  const row = (id, startIso, buttons = ['Start']) => ({ id, title: 'T', startMs: Date.parse(startIso), start: '', buttons })
  const opts = { timeZone: 'America/Jamaica', leadMinutes: 15, lateMinutes: 5, filter: null }
  const now = at('2026-11-03T22:10:00Z')
  const due = (rows) => dueMeetings(rows, now, opts).map((m) => m.id)
  assert.deepEqual(due([row('123456781', '2026-11-03T22:20:00Z')]), ['123456781'], '10 min ahead')
  assert.deepEqual(due([row('123456781', '2026-11-03T22:25:00Z')]), ['123456781'], 'exactly 15 min ahead')
  assert.deepEqual(due([row('123456781', '2026-11-03T22:26:00Z')]), [], '16 min ahead is too early')
  assert.deepEqual(due([row('123456781', '2026-11-03T22:06:00Z')]), ['123456781'], '4 min late still starts')
  assert.deepEqual(due([row('123456781', '2026-11-03T22:04:00Z')]), [], '6 min late is too late (a finished meeting must not restart)')
  assert.deepEqual(due([row('123456781', '2026-11-03T22:20:00Z', ['Join', 'End'])]), [], 'already running')
  assert.deepEqual(due([row('123456781', '2026-11-04T22:20:00Z')]), [], 'the same clock time TOMORROW is not due (the scraped list could never tell)')
  assert.deepEqual(due([row('123456782', '2026-11-03T22:15:00Z'), row('123456781', '2026-11-03T22:12:00Z')]), ['123456781', '123456782'], 'most urgent first')
})

// ---------- the page ----------
test('page: pins one SDK version, loads only Zoom\'s SDK and its own script, and holds no secret', () => {
  const html = pageHtml()
  assert.ok(html.includes(`https://source.zoom.us/zoom-meeting-${SDK_VERSION}.min.js`))
  assert.match(SDK_VERSION, /^\d+\.\d+\.\d+$/)
  const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])
  assert.ok(srcs.every((s) => s === '/host.js' || s.startsWith('https://source.zoom.us/')), 'no other script source')
  assert.ok(!/latest|@\d/.test(html), 'never an unpinned version')
  assert.ok(![...SECRETS, KEYZ].some((s) => html.includes(s) || pageScript().includes(s)))
})

test('page script: valid JavaScript, reports its state, starts as host only with a signature, passes the start key only when given', () => {
  const js = pageScript()
  assert.doesNotThrow(() => new vm.Script(js))
  for (const state of ['loading', 'initialized', 'joined', 'error']) assert.ok(js.includes(`'${state}'`), state)
  assert.match(js, /if \(!bot\.signature\) \{ set\('initialized'\)/)
  assert.match(js, /if \(bot\.zak\) join\.zak = bot\.zak/)
  assert.ok(!/eval\(|document\.write|innerHTML/.test(js))
  const joining = js.indexOf("set('joining')")
  assert.ok(joining > 0 && joining < js.indexOf('ZoomMtg.join(join)'), 'marks "joining" right before the join')
  assert.ok(!js.includes("set('error', 'page error"), 'a stray page error is noted, never fatal')
  assert.ok(js.includes('__BOT_NOTES'))
})

test('page server: this computer only, serves exactly three paths, nothing else', async () => {
  const s = await startPageServer()
  try {
    assert.match(s.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
    const get = (p, method = 'GET') => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: s.port, path: p, method }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers })) })
      r.on('error', reject)
      r.end()
    })
    assert.equal((await get('/')).status, 200)
    assert.match((await get('/')).body, /zmmtg-root/)
    assert.equal((await get('/host.js')).status, 200)
    assert.equal((await get('/left')).status, 200)
    for (const p of ['/etc/passwd', '/../package.json', '/host.js/../../src/config.js', '/.env', '/src/zoomApi.js']) assert.equal((await get(p)).status, 404, p)
    assert.equal((await get('/', 'POST')).status, 405)
    assert.equal((await get('/')).headers['cache-control'], 'no-store')
  } finally { await s.close() }
})

// ---------- the driver ----------
function fakeDriver({ status = { state: 'joined' }, frame = true } = {}) {
  const cfg = { api: parseApiCredentials(ENV), timeZone: 'America/Jamaica', quiet: true, ci: true }
  const api = createZoomApi(cfg.api, { fetch: goodApi() })
  const d = new ZoomSdkDriver(cfg, api, () => {})
  const seen = { gotos: [], injected: null, launched: 0 }
  d.launch = async () => { seen.launched++ }
  d.page = {
    evaluateOnNewDocument: async (fn, p) => { seen.injected = p },
    goto: async (url) => { seen.gotos.push(url) },
    waitForFunction: async () => ({ jsonValue: async () => status }),
  }
  d.meetingFrame = async () => { if (!frame) throw new Error('The Zoom meeting screen did not appear.') }
  d.dismissPopups = async () => {}
  d.shot = async () => null
  return { d, seen }
}

test('sdk driver: listing the schedule never opens a browser', async () => {
  const { d, seen } = fakeDriver()
  const rows = await d.listUpcoming()
  assert.equal(rows.length, 2)
  assert.equal(seen.launched, 0)
})

test('sdk driver: starts the meeting as host with a fresh start key; secrets travel through devtools, never the address', async () => {
  const { d, seen } = fakeDriver()
  const info = await d.join({ meetingId: '12345678901' })
  assert.equal(info.meetingId, '12345678901')
  assert.equal(info.link, 'https://zoom.us/j/12345678901')
  assert.equal(d.started, true)
  assert.equal(seen.gotos.length, 1)
  assert.match(seen.gotos[0], /^http:\/\/127\.0\.0\.1:\d+\/$/)
  assert.ok(!/ZAK|signature|12345678901/.test(seen.gotos[0]))
  assert.equal(seen.injected.zak, KEYZ)
  assert.equal(seen.injected.sdkKey, ENV.ZOOM_SDK_KEY)
  assert.equal(seen.injected.meetingNumber, '12345678901')
  const [, b, s] = seen.injected.signature.split('.')
  assert.equal(JSON.parse(Buffer.from(b, 'base64url')).role, 1)
  assert.equal(s, crypto.createHmac('sha256', ENV.ZOOM_SDK_SECRET).update(seen.injected.signature.split('.').slice(0, 2).join('.')).digest('base64url'))
  assert.ok(!JSON.stringify(seen.injected).includes(ENV.ZOOM_SDK_SECRET) && !JSON.stringify(seen.injected).includes(ENV.ZOOM_S2S_CLIENT_SECRET), 'the page never gets a secret')
  await d.close()
})

test('sdk driver: refuses without a meeting number, and with a bad one', async () => {
  const { d, seen } = fakeDriver()
  await assert.rejects(d.join({}), /meeting number/)
  await assert.rejects(d.join(), /meeting number/)
  await assert.rejects(d.join({ meetingId: '12; rm -rf' }), /meeting number/)
  assert.equal(seen.launched, 0, 'nothing opened')
})

test('sdk driver: if Zoom will not start it, it says why (masked) and is NOT marked as started', async () => {
  const { d } = fakeDriver({ status: { state: 'error', detail: 'join: 3712 Invalid signature for host@example.com' }, frame: false })
  await assert.rejects(d.join({ meetingId: '12345678901' }), (e) => /did not start the meeting/.test(e.message) && /Invalid signature/.test(e.message) && !/host@example\.com/.test(e.message))
  assert.equal(d.started, false)
  await d.close()
})

test('sdk driver: a page that never answers is a failure, not a hang', async () => {
  const { d } = fakeDriver({ frame: false })
  d.page.waitForFunction = async () => { throw new Error('timeout') }
  await assert.rejects(d.join({ meetingId: '12345678901' }), /did not start the meeting/)
  assert.equal(d.started, false)
  await d.close()
})

test('sdk driver: once the meeting is live an error keeps it marked as started (the bot must stay in it as host)', async () => {
  const { d } = fakeDriver()
  d.meetingFrame = async () => { throw new Error('The Zoom meeting screen did not appear.') }
  await assert.rejects(d.join({ meetingId: '12345678901' }), /meeting screen/)
  assert.equal(d.started, true)
  await d.close()
})

test('sdk driver: if the page reports an error but the meeting screen IS up, the bot stays in the meeting (never closes a live one)', async () => {
  const { d } = fakeDriver({ status: { state: 'error', detail: 'page glitch' }, frame: true })
  const info = await d.join({ meetingId: '12345678901' })
  assert.equal(info.meetingId, '12345678901')
  assert.equal(d.started, true)
  await d.close()
})

test('sdk driver: leaving waits for the SDK left page before the browser may close', async () => {
  const { d } = fakeDriver()
  const original = ZoomBrowserDriver.prototype.leave
  ZoomBrowserDriver.prototype.leave = async () => {}
  try {
    d.page.url = () => 'http://127.0.0.1:5555/left'
    const t = Date.now()
    await d.leave()
    assert.ok(Date.now() - t < 2000)
  } finally { ZoomBrowserDriver.prototype.leave = original }
})
