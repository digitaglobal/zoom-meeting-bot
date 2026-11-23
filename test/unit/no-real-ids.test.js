'use strict'
// Guard for the PUBLIC repo: no real-looking Slack user id may be committed. Real ids belong in SETTINGS (GitHub secrets, or the
// environment on your own computer), never in code, tests, fixtures or examples. Made-up ids must look like U0EXAMPLnn (or the
// UGUEST / UDEAD / UBOT test fakes). If this fails it names the FILES only, never the ids, so the failure itself leaks nothing.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', '..')
const SKIP_DIRS = new Set(['node_modules', '.git', '.profile', 'screenshots'])
const SKIP_FILES = /(^|[\\/])(\.env|package-lock\.json)$|\.(png|jpe?g|gif|ico|zip|woff2?)$/i // a local .env is the user's own; lockfile hashes can look like ids
const ALLOWED = [/^U0EXAMPL\d\d$/, /^U(GUEST|DEAD|BOT)\d+$/]

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

test('no real-looking Slack user id is anywhere in the repo (made-up ones must look like U0EXAMPLnn)', () => {
  const bad = []
  for (const file of walk(root)) {
    if (SKIP_FILES.test(file)) continue
    let text
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    for (const m of text.matchAll(/\bU[A-Z0-9]{8,11}\b/g)) {
      const id = m[0]
      if (/[0-9]/.test(id) && !ALLOWED.some((re) => re.test(id))) bad.push(path.relative(root, file))
    }
  }
  assert.deepEqual([...new Set(bad)], [], 'These files hold a Slack-id-shaped value that is not an allowed made-up one (the values are not printed on purpose)')
})

test('the guard itself recognises a real-looking id and accepts the made-up ones', () => {
  const looksReal = (id) => /[0-9]/.test(id) && !ALLOWED.some((re) => re.test(id))
  assert.equal(looksReal(['U0AB', '12CD34'].join('')), true, 'built at runtime so this file itself holds no id-shaped value')
  assert.equal(looksReal('U0EXAMPL01'), false)
  assert.equal(looksReal('UGUEST0000'), false)
  assert.equal(looksReal('UPPERCASEX'), false, 'ordinary capitalised words have no digit, so they are not ids')
})

test('a real staff list can never be committed by accident: staff.json is git-ignored and the made-up example stays tracked', () => {
  const lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/).map((l) => l.trim())
  assert.ok(lines.includes('staff.json'), 'staff.json must be in .gitignore')
  assert.ok(lines.includes('staff.*.json'), 'staff.*.json must be in .gitignore')
  // an ignore pattern (not a "!" un-ignore line, not a comment) that would also swallow staff.json.example
  assert.ok(!lines.some((l) => !/^[!#]/.test(l) && /^staff\*|^staff\.json\*|\.example$/.test(l)), 'the example file must not be ignored')
  assert.ok(fs.existsSync(path.join(root, 'staff.json.example')))
})
