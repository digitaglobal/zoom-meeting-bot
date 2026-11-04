'use strict'
// This repository is meant to be PUBLIC, so these tests guard against the ways a public repository leaks a login:
// forks' code running with secrets, caches or artifacts carrying credentials, unpinned third-party actions, secrets in
// shell lines, and committed credential files. A future edit that breaks one of these rules fails here.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..', '..')
// What git would commit (tracked + untracked-not-ignored): the local git-ignored .env is not one of them; a broken .gitignore would put it back in.
const COMMITTABLE = (() => {
  const r = spawnSync('git', ['ls-files', '-z', '-c', '-o', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' })
  return r.status === 0 ? new Set(r.stdout.split('\0').filter(Boolean)) : null
})()
const committable = (rel) => !COMMITTABLE || COMMITTABLE.has(rel)
const WORKFLOWS = path.join(ROOT, '.github', 'workflows')
const files = fs.existsSync(WORKFLOWS) ? fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)) : []
const read = (f) => fs.readFileSync(path.join(WORKFLOWS, f), 'utf8')
// the active lines only (comments are explanations, not behaviour)
const code = (f) => read(f).split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n')

test('workflows: there is at least one, so these checks mean something', () => {
  assert.ok(files.length >= 1)
})

test('workflows: started only by the schedule or a manual click, never by a pull request or a comment', () => {
  for (const f of files) {
    const s = code(f)
    for (const trigger of ['pull_request', 'pull_request_target', 'issue_comment', 'issues', 'workflow_run', 'push', 'fork', 'watch', 'repository_dispatch']) {
      assert.ok(!new RegExp(`^\\s{2}${trigger}\\s*:`, 'm').test(s) && !new RegExp(`^on:\\s*\\[?.*\\b${trigger}\\b`, 'm').test(s), `${f} is triggered by ${trigger}`)
    }
    assert.match(s, /^\s{2}schedule\s*:/m)
    assert.match(s, /^\s{2}workflow_dispatch\s*:/m)
  }
})

test('workflows: the run may only read the repository', () => {
  for (const f of files) {
    const s = code(f)
    assert.match(s, /^permissions:\s*\n\s+contents:\s*read\s*$/m, `${f} must set permissions: contents: read at the top`)
    assert.ok(!/(write|admin)\b/.test(s.match(/^permissions:[\s\S]*?(?=^\S)/m)?.[0] || ''), `${f} grants a write permission`)
  }
})

test('workflows: nothing that stores or shares data between runs (caches, artifacts)', () => {
  for (const f of files) {
    const s = code(f)
    assert.ok(!/actions\/cache/.test(s), `${f} uses actions/cache`)
    assert.ok(!/upload-artifact|download-artifact/.test(s), `${f} uses artifacts`)
    assert.ok(!/^\s+cache\s*:/m.test(s), `${f} turns on a setup-* cache`)
    assert.ok(!/actions\/upload-pages|gh-pages|deploy/i.test(s), `${f} publishes something`)
  }
})

test('workflows: every third-party action is pinned to an exact commit', () => {
  for (const f of files) {
    const uses = [...code(f).matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1])
    assert.ok(uses.length >= 1)
    for (const u of uses) assert.match(u, /@[0-9a-f]{40}$/, `${f}: "${u}" is not pinned to a commit hash`)
  }
})

test('workflows: secrets are only passed as environment variables, never written into a shell line or echoed', () => {
  for (const f of files) {
    const lines = code(f).split('\n')
    lines.forEach((l, i) => {
      if (/\bsecrets\./.test(l)) assert.match(l, /^\s+[A-Z][A-Z0-9_]*:\s*\$\{\{\s*secrets\.[A-Z0-9_]+\s*\}\}\s*$/, `${f}:${i + 1} uses a secret outside an env: entry`)
      if (/^\s*run:/.test(l) || /^\s+(node|npm|echo|curl|bash)\b/.test(l)) {
        assert.ok(!/\$\{\{/.test(l), `${f}:${i + 1} puts a \${{ }} expression inside a command (script injection risk): pass it through env:`)
      }
    })
    assert.ok(!/\becho\b/.test(code(f)) || !/secrets|SESSION/i.test(code(f).match(/echo.*/g)?.join('') || ''), `${f} echoes a secret`)
    assert.ok(!/ACTIONS_STEP_DEBUG|ACTIONS_RUNNER_DEBUG/.test(code(f)), `${f} turns on debug logging`)
  }
})

test('workflows: the checkout does not leave the repository token on disk', () => {
  for (const f of files) assert.match(code(f), /persist-credentials:\s*false/)
})

test('repository: no credential, saved session or browser profile is committed', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
  for (const must of ['.env', '.profile/', '.session', 'screenshots/', 'node_modules/']) {
    assert.ok(ignore.split(/\r?\n/).some((l) => l.trim().startsWith(must)), `.gitignore must contain ${must}`)
  }
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.profile', 'screenshots'].includes(e.name)) continue
      const p = path.join(dir, e.name)
      e.isDirectory() ? walk(p, out) : out.push(p)
    }
    return out
  }
  for (const p of walk(ROOT)) {
    const rel = path.relative(ROOT, p).replace(/\\/g, '/')
    if (!committable(rel)) continue
    assert.ok(!/(^|\/)\.env(\.|$)/.test(rel) || /\.env\.example$/.test(rel), `${rel} looks like a real .env file`)
    assert.ok(!/session\.b64|\.session/.test(rel), `${rel} looks like a saved session`)
    assert.ok(!/\.(png|jpe?g|pem|key|p12|pfx)$/i.test(rel), `${rel} is a binary file that could hold private data`)
  }
})

test('repository: no committed file contains a password, a token, or someone\'s email address', () => {
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.profile', 'screenshots'].includes(e.name) || e.name === 'package-lock.json') continue
      const p = path.join(dir, e.name)
      e.isDirectory() ? walk(p, out) : out.push(p)
    }
    return out
  }
  const patterns = [
    [/[A-Za-z0-9._%+-]+@(?!example\.com|b\.com|x\.com|users\.noreply\.github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/, 'an email address'],
    [/gh[pousr]_[A-Za-z0-9]{30,}/, 'a GitHub token'],
    [/xox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
    [/(password|passwd|secret|token)\s*[:=]\s*['"][^'"\s]{8,}['"]/i, 'a hard-coded secret'],
    [/\b[A-Za-z0-9+/]{200,}={0,2}\b/, 'a long encoded blob (could be a saved session)'],
  ]
  for (const p of walk(ROOT)) {
    const rel = path.relative(ROOT, p).replace(/\\/g, '/')
    if (!committable(rel)) continue
    if (rel === 'test/unit/workflow-safety.test.js') continue // this file contains the patterns themselves
    const s = fs.readFileSync(p, 'utf8')
    for (const [re, what] of patterns) assert.ok(!re.test(s), `${rel} contains ${what}`)
  }
})

test('repository: .gitignore covers every env file, saved session and browser profile (a typo here would publish a login)', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim())
  for (const must of ['.env*', '!.env.example', '.profile/', '.session*', '*.b64', '.zoom-meeting-bot/', 'screenshots/', 'node_modules/']) {
    assert.ok(lines.includes(must), `.gitignore must contain exactly "${must}"`)
  }
})

test('repository: the public files contain no real-looking Zoom meeting number (names cannot be checked by a test)', () => {
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', '.profile', 'screenshots'].includes(e.name) || e.name === 'package-lock.json') continue
      const p = path.join(dir, e.name)
      e.isDirectory() ? walk(p, out) : out.push(p)
    }
    return out
  }
  // Meeting numbers in committed files must be obviously fake: all one digit, or 111 000 xxxx, 111 222 3333, 444 555 6666, 123456789...
  // (1x00000000 are the round fake cookie-expiry timestamps used by session.test.js)
  const FAKE = /^(1110{4,6}\d{3}|1112223333|4445556666|(\d)\2{8,10}|12345678\d{1,4}|123456789\d{0,3}|1\d00000000)$/
  for (const p of walk(ROOT)) {
    const rel = path.relative(ROOT, p).replace(/\\/g, '/')
    if (!committable(rel)) continue
    const s = fs.readFileSync(p, 'utf8')
    for (const m of s.matchAll(/(?<!\d)(\d{3,4})[ -]?(\d{3,4})[ -]?(\d{3,4})(?!\d)/g)) {
      const digits = m[0].replace(/\D/g, '')
      if (digits.length < 9 || digits.length > 12) continue
      assert.match(digits, FAKE, `${rel} contains "${m[0]}", which looks like a real Zoom meeting number`)
    }
  }
})

test('workflows: the tests run BEFORE the login is used, so a broken safety rule stops the run', () => {
  for (const f of files) {
    const s = code(f)
    const tests = s.indexOf('run: npm test')
    const tick = s.indexOf('src/cli.js')
    assert.ok(tests > 0 && tick > 0, `${f} must run npm test and the bot`)
    assert.ok(tests < tick, `${f} must run the tests before the bot`)
    assert.ok(s.indexOf('ZOOM_SESSION') > tests, `${f}: the secret must only be given to the step after the tests`)
    assert.ok(s.indexOf('BACKUP_HOST_NAMES') > tests, `${f}: the backup host names must only be given to the step after the tests`)
    assert.match(s, /^\s+BACKUP_HOST_NAMES:\s*\$\{\{\s*secrets\.BACKUP_HOST_NAMES\s*\}\}\s*$/m, `${f}: BACKUP_HOST_NAMES must be a secret environment entry`)
    for (const name of ['ZOOM_ACCOUNT_ID', 'ZOOM_S2S_CLIENT_ID', 'ZOOM_S2S_CLIENT_SECRET', 'ZOOM_SDK_KEY', 'ZOOM_SDK_SECRET', 'ZOOM_HOST_EMAIL']) {
      assert.ok(s.indexOf(name) > tests, `${f}: ${name} must only be given to the step after the tests`)
      assert.match(s, new RegExp(`^\\s+${name}:\\s*\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}\\s*$`, 'm'), `${f}: ${name} must be a secret environment entry`)
    }
  }
})

test('workflows: the stuck-run limits are consistent (the wait is shorter than the run limit, the lead is wide enough for 2 checks)', () => {
  for (const f of files) {
    const s = code(f)
    const limit = Number(/timeout-minutes:\s*(\d+)/.exec(s)[1])
    const wait = Number(/WAIT_FOR_NEW_HOST_SECONDS:\s*'(\d+)'/.exec(s)[1])
    const lead = Number(/LEAD_MINUTES:\s*'(\d+)'/.exec(s)[1])
    assert.ok(wait / 60 + 3 < limit, `${f}: the wait (${wait / 60} min) must end before the ${limit}-minute limit`)
    assert.ok(lead >= 15, `${f}: with a check every 10 minutes the lead must be at least 15 minutes`)
  }
})

// ---- the private report and the outside timers ----
test('workflows: a hand-over run and a dry-run login check or test report never wait for, or cancel, each other', () => {
  for (const f of files) {
    assert.match(code(f), /group:\s*zoom-host-handover\$\{\{\s*\(inputs\.dry_run == true \|\| inputs\.send_test_report == true\) && '-check' \|\| ''\s*\}\}/, `${f}: the dry-run check needs its own concurrency group`)
    assert.match(code(f), /cancel-in-progress:\s*false/)
  }
})

test('workflows: the "run failed" step runs last, only on a failure, skips the backup schedule, and gets only the report address', () => {
  for (const f of files) {
    const s = code(f)
    const at = s.indexOf('src/report-failure.js')
    assert.ok(at > s.indexOf('src/cli.js'), `${f}: the failure step must come after the bot step`)
    const step = s.slice(s.lastIndexOf('- name:', at))
    assert.match(step, /^\s+if:\s*failure\(\)\s*&&\s*github\.event_name != 'schedule'\s*$/m, `${f}: the failure step must only run on a failure, and not for the schedule`)
    assert.deepEqual([...step.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]), ['REPORT_WEBHOOK_URL'], `${f}: the failure step may only be given the report address`)
    assert.ok(!/ZOOM_SESSION|NEW_HOST_NAME|BACKUP_HOST_NAMES|ZOOM_ACCOUNT_ID|ZOOM_S2S_|ZOOM_SDK_|ZOOM_HOST_EMAIL/.test(step), `${f}: the failure step must not see the login, the Zoom API credentials or the host names`)
  }
})

test('workflows: the bot step gets the report address only as a secret environment entry', () => {
  for (const f of files) assert.match(code(f), /^\s+REPORT_WEBHOOK_URL:\s*\$\{\{\s*secrets\.REPORT_WEBHOOK_URL\s*\}\}\s*$/m)
})

test('workflows: the "send one test report" button is off by default and wins over the other modes; the other modes keep their arguments', () => {
  for (const f of files) {
    const s = code(f)
    assert.match(s, /send_test_report:\s*\n\s+description:[^\n]*\n\s+type:\s*boolean\n\s+default:\s*false/, `${f}: the test-report input must default to false`)
    assert.match(s, /TICK_ARGS:\s*\$\{\{\s*inputs\.send_test_report == true && '--test-report' \|\| inputs\.dry_run == true && '--dry-run' \|\| ''\s*\}\}/, `${f}: the arguments must be test-report, then dry-run, then none`)
  }
})
