'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { loadDotEnv, loadConfig, findChrome } = require('../../src/config')

test('config: the Zoom login is required', () => {
  assert.throws(() => loadConfig({}), /ZOOM_USERNAME, ZOOM_PASSWORD/)
  assert.throws(() => loadConfig({ ZOOM_USERNAME: 'a@b.com' }), /ZOOM_PASSWORD/)
})

test('config: sensible defaults', () => {
  const c = loadConfig({ ZOOM_USERNAME: ' a@b.com ', ZOOM_PASSWORD: 'p w' })
  assert.equal(c.username, 'a@b.com')
  assert.equal(c.password, 'p w')
  assert.equal(c.newHostName, 'Kemal')
  assert.equal(c.waitSeconds, 1800)
  assert.equal(c.headed, false, 'runs hidden unless asked')
  assert.equal(loadConfig({ ZOOM_USERNAME: 'a@b.com', ZOOM_PASSWORD: 'x', HEADED: '1' }).headed, true)
})

test('config: bad wait and empty host name are refused', () => {
  const base = { ZOOM_USERNAME: 'a@b.com', ZOOM_PASSWORD: 'x' }
  assert.throws(() => loadConfig({ ...base, WAIT_FOR_NEW_HOST_SECONDS: '3' }), /at least 10/)
  assert.throws(() => loadConfig({ ...base, WAIT_FOR_NEW_HOST_SECONDS: 'abc' }), /at least 10/)
  assert.throws(() => loadConfig({ ...base, NEW_HOST_NAME: '   ' }), /cannot be empty/i)
  assert.equal(loadConfig({ ...base, HEADED: '0' }).headed, false)
})

test('loadDotEnv: reads KEY=value, strips quotes, skips comments, never overrides', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-')), '.env')
  fs.writeFileSync(f, '# comment\nZOOM_USERNAME="me@x.com"\nZOOM_PASSWORD=pa ss\nNEW_HOST_NAME=Maria\n')
  const env = { NEW_HOST_NAME: 'Kemal' }
  loadDotEnv(f, env)
  assert.equal(env.ZOOM_USERNAME, 'me@x.com')
  assert.equal(env.ZOOM_PASSWORD, 'pa ss')
  assert.equal(env.NEW_HOST_NAME, 'Kemal', 'an existing value wins')
  loadDotEnv(path.join(os.tmpdir(), 'does-not-exist.env'), env) // missing file is fine
})

test('findChrome: explicit path must exist; otherwise the first installed browser', () => {
  assert.throws(() => findChrome('X:\\nope.exe', () => false), /does not exist/)
  assert.equal(findChrome('X:\\mine.exe', () => true), 'X:\\mine.exe')
  assert.throws(() => findChrome('', () => false), /Could not find Chrome/)
  assert.match(findChrome('', (p) => p.includes('msedge')), /msedge/)
})

// ---- source safety: these protect the rules, so a future edit cannot quietly break them ----
const SRC = path.join(__dirname, '..', '..', 'src')
const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.js'))
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8')

test('safety: no code path can end the meeting for everyone', () => {
  for (const f of files) {
    const s = read(f)
    assert.ok(!/end\s+meeting\s+for\s+all/i.test(s), `${f} mentions ending the meeting for everyone`)
    assert.ok(!/endMeeting/.test(s), `${f} calls endMeeting`)
  }
})

test('safety: the only Leave click is the plain "Leave Meeting" button', () => {
  const s = read('browserDriver.js')
  assert.ok(/=== 'Leave Meeting'/.test(s))
  // the footer button the bot presses is "Leave" only, never "End"
  assert.ok(/\^leave\$/i.test(s) && !/\^\(leave\|end\)/i.test(s))
})

test('safety: the password is used only to type into the sign-in form and is never logged', () => {
  for (const f of files) {
    const s = read(f)
    assert.ok(!/(log|console\.\w+)\([^)]*password/i.test(s), `${f} logs the password`)
  }
  const driver = read('browserDriver.js')
  const uses = driver.match(/cfg\.password/g) || []
  assert.equal(uses.length, 1, 'password is read exactly once (the sign-in form)')
})
