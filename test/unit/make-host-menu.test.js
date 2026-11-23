'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')

const srcDir = fs.existsSync(path.join(__dirname, '../src/makeHostMenu.js'))
  ? path.join(__dirname, '../src')
  : path.join(__dirname, '../../src')

const {
  isMoreButton,
  menuFailureSnippet,
  parseUserId,
  pickParticipantRow,
  makeHostRetryDelays,
  runMakeHostClickLoop,
  resolveSdkAttendee,
  unfinishedHandoverText,
  errorReportLooksLikeMenuFailure,
  menuErrorReportText,
  attemptOpenMoreMenu,
  attemptClickMakeHostItem,
  DEFAULT_BUDGET_MS,
} = require(path.join(srcDir, 'makeHostMenu.js'))

function btn(attrs = {}) {
  return {
    textContent: attrs.textContent || '',
    getAttribute(k) { return (k in attrs) ? attrs[k] : null },
    click() { this.clicked = true },
    getBoundingClientRect() { return { width: attrs.hidden ? 0 : 12, height: attrs.hidden ? 0 : 12 } },
  }
}

function row({ name, waiting = false, more = null, moreUntilHover = false, buttons = [] }) {
  const moreBtn = more === null ? null : (typeof more === 'object' && more.getAttribute ? more : btn(typeof more === 'string' ? { 'aria-label': more } : more))
  const admit = waiting ? btn({ textContent: 'Admit' }) : null
  let extra = [...buttons]
  const node = {
    name,
    scrolled: false,
    events: [],
    moreUntilHover,
    moreBtn,
    scrollIntoView() { this.scrolled = true },
    dispatchEvent(ev) {
      this.events.push(ev && ev.type ? ev.type : ev)
      if (this.moreUntilHover && moreBtn && /mouseover|mouseenter|pointerover/.test(ev && ev.type)) this.moreUntilHover = false
      return true
    },
    getBoundingClientRect() { return { width: 100, height: 24 } },
    querySelector(sel) {
      const all = this.querySelectorAll(sel)
      return all[0] || null
    },
    querySelectorAll(sel) {
      if (sel === '.participants-item__display-name') return [{ textContent: this.name }]
      if (sel === 'button' || sel === 'button, [role=button]') {
        const out = []
        if (admit) out.push(admit)
        if (this.moreBtn && !this.moreUntilHover) out.push(this.moreBtn)
        out.push(...extra)
        return out
      }
      return []
    },
  }
  return node
}

function installDocument(rows, { panelOpen = true, menuItems = [] } = {}) {
  const previous = global.document
  const panel = panelOpen ? { getBoundingClientRect() { return { width: 280, height: 400 } } } : null
  global.document = {
    querySelector(sel) {
      if (sel === '.participants-section-container') return panel
      return this.querySelectorAll(sel)[0] || null
    },
    querySelectorAll(sel) {
      if (sel === '.participants-item-position') return rows
      if (/role=menuitem|dropdown-menu/.test(sel)) return menuItems
      return []
    },
  }
  return () => { global.document = previous }
}

test('parseUserId splits the made-up "name#n" id the panel uses', () => {
  assert.deepEqual(parseUserId('Jordan B.#1'), { name: 'Jordan B.', index: 1 })
  assert.deepEqual(parseUserId('Parker Lane#2'), { name: 'Parker Lane', index: 2 })
})

test('isMoreButton accepts More options, More, More actions, and a more menu button', () => {
  assert.equal(isMoreButton(btn({ 'aria-label': 'More options' })), true, 'the current exact label')
  assert.equal(isMoreButton(btn({ 'aria-label': 'More' })), true)
  assert.equal(isMoreButton(btn({ 'aria-label': 'More actions' })), true)
  assert.equal(isMoreButton(btn({ title: 'See more' })), true)
  assert.equal(isMoreButton(btn({ 'aria-label': 'More', 'aria-haspopup': 'menu' })), true)
  assert.equal(isMoreButton(btn({ 'aria-label': 'Mute' })), false)
  assert.equal(isMoreButton(btn({ textContent: 'Admit' })), false)
})

test('pickParticipantRow prefers the in-meeting row over a leftover waiting-room row of the same name', () => {
  const waiting = row({ name: 'Jordan B.', waiting: true, more: 'More options' })
  const inside = row({ name: 'Jordan B.', waiting: false, more: 'More options' })
  const other = row({ name: 'Guest', waiting: false, more: 'More options' })
  const picked = pickParticipantRow([waiting, other, inside], 'Jordan B.#1', { preferInside: true })
  assert.equal(picked, inside)
})

test('menuFailureSnippet never includes a person\'s name', () => {
  const text = menuFailureSnippet({ reason: 'no-more-button', panelOpen: true, rowCount: 4, namedRowCount: 1, waiting: false, hasMoreButton: false, buttonCount: 1, buttonLabels: ['Mute Jordan Banks'], inViewport: true })
  assert.equal(/Jordan|Banks|Parker|Riley/i.test(text), false)
  assert.match(text, /reason=no-more-button/)
  assert.match(text, /buttonCount=1/)
  assert.match(text, /hasMoreButton=false/)
  assert.equal(/buttonLabels|Mute/i.test(text), false, 'no button text at all, only counts')
})

test('makeHostRetryDelays starts immediately and stays within a 20 second budget', () => {
  const steps = makeHostRetryDelays({ budgetMs: DEFAULT_BUDGET_MS, firstDelayMs: 400, maxDelayMs: 4000 })
  assert.equal(steps[0].waitMs, 0)
  assert.ok(steps.length >= 5)
  const total = steps.reduce((s, x) => s + x.waitMs, 0)
  assert.ok(total <= DEFAULT_BUDGET_MS, `used ${total}ms`)
  assert.ok(total >= 10000, 'covers a useful wait after admit, not just one retry')
})

test('attemptOpenMoreMenu clicks the exact "More options" button', () => {
  const jordan = row({ name: 'Jordan B.', more: 'More options' })
  const restore = installDocument([row({ name: 'Guest', more: 'More options' }), jordan])
  try {
    const out = attemptOpenMoreMenu('Jordan B.#1')
    assert.equal(out.ok, true)
    assert.equal(jordan.moreBtn.clicked, true)
    assert.equal(jordan.scrolled, true)
  } finally { restore() }
})

test('attemptOpenMoreMenu hovers first so a hover-only More button can appear', () => {
  const jordan = row({ name: 'Jordan B.', more: 'More options', moreUntilHover: true })
  const restore = installDocument([jordan])
  try {
    const out = attemptOpenMoreMenu('Jordan B.#1')
    assert.equal(out.ok, true, out.snippet)
    assert.ok(jordan.events.includes('mouseover') || jordan.events.includes('pointerover'))
    assert.equal(jordan.moreBtn.clicked, true)
  } finally { restore() }
})

test('attemptOpenMoreMenu also finds aria-label "More" as a fallback', () => {
  const jordan = row({ name: 'Jordan B.', more: 'More' })
  const restore = installDocument([jordan])
  try {
    const out = attemptOpenMoreMenu('Jordan B.#1')
    assert.equal(out.ok, true, out.snippet)
    assert.equal(jordan.moreBtn.clicked, true)
  } finally { restore() }
})

test('attemptOpenMoreMenu reports a redacted snippet when the row is still missing', () => {
  const restore = installDocument([row({ name: 'Guest', more: 'More options' })])
  try {
    const out = attemptOpenMoreMenu('Jordan B.#1')
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'row-missing')
    assert.match(out.snippet, /namedRows=0/)
    assert.equal(/Jordan|Banks/i.test(out.snippet), false)
  } finally { restore() }
})

test('attemptOpenMoreMenu reports no-more-button when the row is there but the menu button is not', () => {
  const jordan = row({ name: 'Jordan B.', more: null, buttons: [btn({ 'aria-label': 'Mute' })] })
  const restore = installDocument([jordan])
  try {
    const out = attemptOpenMoreMenu('Jordan B.#1')
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'no-more-button')
    assert.match(out.snippet, /buttonCount=1/)
    assert.match(out.snippet, /hasMoreButton=false/)
    assert.equal(/buttonLabels|Mute/i.test(out.snippet), false)
  } finally { restore() }
})

test('attemptClickMakeHostItem clicks a Make Host menu item and ignores other items', () => {
  const host = { textContent: 'Make Host', click() { this.clicked = true } }
  const mute = { textContent: 'Mute', click() { this.clicked = true } }
  const restore = installDocument([], { menuItems: [mute, host] })
  try {
    const out = attemptClickMakeHostItem()
    assert.equal(out.ok, true)
    assert.equal(host.clicked, true)
    assert.equal(mute.clicked, undefined)
  } finally { restore() }
})

test('runMakeHostClickLoop retries until the row and menu appear, then clicks Make Host', async () => {
  const calls = { panel: 0, menu: 0, item: 0, sleeps: [] }
  const out = await runMakeHostClickLoop({
    budgetMs: 20000,
    afterOpenWaitMs: 10,
    sleep: async (ms) => { calls.sleeps.push(ms) },
    openPanel: async () => { calls.panel++ },
    openMenu: async () => {
      calls.menu++
      if (calls.menu < 3) return { ok: false, reason: 'row-missing', snippet: 'rows=1 namedRows=0' }
      return { ok: true, reason: 'clicked', snippet: 'clicked' }
    },
    clickItem: async () => { calls.item++; return { ok: true, reason: 'clicked-make-host' } },
    dismissMenu: async () => {},
  })
  assert.equal(out.ok, true)
  assert.equal(calls.menu, 3)
  assert.equal(calls.item, 1)
  assert.ok(calls.sleeps.includes(400) || calls.sleeps.includes(10))
})

test('runMakeHostClickLoop gives up as a failure after the budget, keeping the last snippet', async () => {
  const out = await runMakeHostClickLoop({
    budgetMs: 800,
    firstDelayMs: 400,
    afterOpenWaitMs: 0,
    sleep: async () => {},
    openPanel: async () => {},
    openMenu: async () => ({ ok: false, reason: 'no-more-button', snippet: 'reason=no-more-button buttonCount=1 hasMoreButton=false' }),
    clickItem: async () => ({ ok: false }),
  })
  // override: runMakeHostClickLoop uses makeHostRetryDelays({ budgetMs }) only
  assert.equal(out.ok, false)
  assert.equal(out.last.reason, 'no-more-button')
  assert.match(out.last.snippet, /no-more-button/)
})

test('resolveSdkAttendee matches the exact display name and refuses a guest with the same first name', () => {
  const list = [
    { userId: 11, userName: 'Meeting host bot' },
    { userId: 22, userName: 'Jordan B.' },
    { userId: 33, userName: 'Jordan Smith' },
  ]
  assert.deepEqual(resolveSdkAttendee(list, 'Jordan B.'), { ok: true, userId: 22, count: 1 })
  assert.equal(resolveSdkAttendee(list, 'Jordan Smith').userId, 33)
  assert.equal(resolveSdkAttendee(list, 'Parker Lane').reason, 'not-in-sdk-list')
  assert.equal(resolveSdkAttendee([{ userId: 1, userName: 'Jordan B.' }, { userId: 2, userName: 'Jordan B.' }], 'Jordan B.').reason, 'ambiguous')
})

test('unfinishedHandoverText distinguishes "did not join" from "joined but the click failed"', () => {
  const missing = unfinishedHandoverText({ reason: 'new-host-not-found', which: ' "Interview"', run: ' Details: https://example/run' })
  assert.match(missing, /did NOT finish/)
  assert.match(missing, /did not join/)
  assert.match(missing, /staying in the meeting as host/)
  assert.equal(/hand-over click failed/.test(missing), false)

  const click = unfinishedHandoverText({ reason: 'host-menu-failed', which: ' "Interview"' })
  assert.match(click, /the new host joined/)
  assert.match(click, /hand-over click failed/)
  assert.match(click, /host-menu-failed/)
  assert.equal(/did not join/.test(click), false)
  assert.equal(/has not joined/.test(click), false)
})

test('a leftover error event that mentions the menu is not described as a sign-in failure', () => {
  assert.equal(errorReportLooksLikeMenuFailure('Could not open the menu for that person.'), true)
  assert.equal(errorReportLooksLikeMenuFailure('Zoom did not offer "Make Host" for that person.'), true)
  assert.equal(errorReportLooksLikeMenuFailure('Zoom is not signed in and there is no password'), false)
  const text = menuErrorReportText({ detail: 'Could not open the menu for that person.' })
  assert.match(text, /the new host joined/)
  assert.match(text, /hand-over click failed/)
  assert.equal(/export-session/.test(text), false)
})
test('a button whose label holds a person\'s name never reaches the failure note (the cloud log is public)', () => {
  const jordan = row({ name: 'Jordan B.', more: null, buttons: [btn({ 'aria-label': 'Unmute Jordan Banks' }), btn({ title: 'Chat with Parker Lane' })] })
  const restore = installDocument([jordan])
  try {
    const out = attemptOpenMoreMenu('Jordan B.#1')
    assert.equal(out.ok, false)
    assert.equal(out.reason, 'no-more-button')
    assert.match(out.snippet, /buttonCount=2/)
    assert.match(out.snippet, /hasMoreButton=false/)
    assert.equal(/Jordan|Banks|Parker|Lane|Unmute|Chat/i.test(out.snippet), false, out.snippet)
  } finally { restore() }
})

test('a row that DOES have a More options button reports hasMoreButton=true with the count, still no text', () => {
  const jordan = row({ name: 'Jordan B.', more: 'More options', buttons: [btn({ 'aria-label': 'Unmute Jordan Banks' })] })
  const restore = installDocument([jordan])
  try {
    const out = attemptOpenMoreMenu('Jordan B.#1')
    assert.equal(out.ok, true)
    assert.match(out.snippet, /hasMoreButton=true/)
    assert.match(out.snippet, /buttonCount=2/)
    assert.equal(/Jordan|Banks|Unmute|More options/i.test(out.snippet), false, out.snippet)
  } finally { restore() }
})

test('the failure note the driver writes to the log carries only counts and yes/no answers', async () => {
  const { ZoomBrowserDriver } = require(path.join(srcDir, 'browserDriver.js'))
  const lines = []
  const jordan = row({ name: 'Jordan B.', more: null, buttons: [btn({ 'aria-label': 'Unmute Jordan Banks' })] })
  const restore = installDocument([jordan])
  try {
    const fake = { log: (m) => lines.push(m), shot: async () => null, cfg: {} }
    const out = attemptOpenMoreMenu('Jordan B.#1')
    await ZoomBrowserDriver.prototype.captureMenuFailure.call(fake, 'makehost-no-menu', out.snippet)
    const logged = lines.join('\n')
    assert.match(logged, /Make Host failed \(makehost-no-menu\): reason=no-more-button/)
    assert.match(logged, /buttonCount=1 /)
    assert.equal(/Jordan|Banks|Unmute|buttonLabels/i.test(logged), false, logged)
  } finally { restore() }
})

test('menuFailureSnippet refuses to print anything but counts, yes/no answers and a plain reason', () => {
  const text = menuFailureSnippet({ reason: 'no more <button> Jordan Banks!', panelOpen: 'Jordan', rowCount: 'Banks', buttonCount: 'x', hasMoreButton: 'yes', buttonLabels: ['Jordan Banks'], labels: ['Parker Lane'] })
  assert.equal(/Jordan|Banks|Parker|Lane|<|>|!/i.test(text.replace(/panelOpen=true/, '')), false, text)
  assert.match(text, /rows=n\/a/)
  assert.match(text, /buttonCount=n\/a/)
})
