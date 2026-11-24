'use strict'
// Pure helpers for the Make Host click: finding the person's More menu, retrying with backoff,
// talking to Zoom's Meeting SDK when it is present, and writing a redacted failure note.
// These functions are safe to unit-test without Chrome or Zoom. attemptOpenMoreMenu and
// attemptClickMakeHostItem are written so Puppeteer can run them inside the meeting page
// (they must not close over Node modules).

const DEFAULT_BUDGET_MS = 20000
const DEFAULT_FIRST_DELAY_MS = 400
const DEFAULT_MAX_DELAY_MS = 4000
const DEFAULT_AFTER_OPEN_WAIT_MS = 900

function normName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isMoreButton(btn) {
  if (!btn) return false
  const aria = String((btn.getAttribute && btn.getAttribute('aria-label')) || '').trim()
  const title = String((btn.getAttribute && btn.getAttribute('title')) || '').trim()
  const text = String(btn.textContent || '').trim()
  const popup = String((btn.getAttribute && btn.getAttribute('aria-haspopup')) || '').trim()
  if (/^more options$/i.test(aria)) return true
  if (/^more$/i.test(aria) || /^more$/i.test(text)) return true
  if (/more options|more actions|see more|open more/i.test(aria) || /more options|more actions|see more/i.test(title)) return true
  if (/^more$/i.test(popup === 'menu' ? aria || text : '')) return true
  if (popup === 'menu' && /more/i.test(`${aria} ${title} ${text}`)) return true
  return false
}

// What the page looked like when the menu click failed: COUNTS and yes/no answers only (how many buttons the row had, and
// whether a "More options" button was among them). Never a button's text, a person's name, or any other text from the page,
// because the cloud log of this repo is public.
function menuFailureSnippet(info = {}) {
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? 'n/a' : Number(v))
  const yn = (v) => (v == null ? 'n/a' : !!v)
  const KNOWN_REASONS = ['row-missing', 'no-more-button', 'click-failed', 'clicked', 'panel-closed', 'no-make-host-item', 'make-host-click-failed', 'clicked-make-host', 'not-tried']
  const reason = KNOWN_REASONS.includes(info.reason) ? info.reason : 'unknown' // a fixed list: nothing from the page can ride in here
  const parts = [
    `reason=${reason}`,
    `panelOpen=${yn(info.panelOpen)}`,
    `rows=${num(info.rowCount)}`,
    `namedRows=${num(info.namedRowCount)}`,
    `waiting=${yn(info.waiting)}`,
    `hasMoreButton=${yn(info.hasMoreButton)}`,
    `buttonCount=${num(info.buttonCount)}`,
    `inViewport=${yn(info.inViewport)}`,
  ]
  return parts.join(' ')
}

function parseUserId(userId) {
  const raw = String(userId || '')
  const at = raw.lastIndexOf('#')
  if (at <= 0) return { name: raw, index: 1 }
  return { name: raw.slice(0, at), index: Number(raw.slice(at + 1)) || 1 }
}

function rowDisplayName(row) {
  if (!row) return ''
  const el = row.querySelector && row.querySelector('.participants-item__display-name')
  return String((el && el.textContent) || '').trim()
}

function rowIsWaiting(row) {
  if (!row) return false
  const buttons = (row.querySelectorAll && row.querySelectorAll('button')) || []
  return [...buttons].some((b) => /^admit$/i.test(String(b.textContent || '').trim()))
}

function pickParticipantRow(rows, userId, { preferInside = true } = {}) {
  const { name, index } = parseUserId(userId)
  const list = [...(rows || [])]
  const named = list.filter((r) => rowDisplayName(r) === name)
  if (preferInside) {
    const inside = named.filter((r) => !rowIsWaiting(r))
    if (inside.length === 1) return inside[0]
    if (inside.length >= index) return inside[index - 1]
  }
  return named[index - 1] || named[0] || null
}

function hoverRow(row) {
  if (!row) return
  try { if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch { /* not in a real page */ }
  for (const type of ['pointerover', 'mouseover', 'mouseenter']) {
    try {
      const ev = typeof MouseEvent === 'function' ? new MouseEvent(type, { bubbles: true, cancelable: true, view: typeof window !== 'undefined' ? window : undefined }) : { type }
      if (row.dispatchEvent) row.dispatchEvent(ev)
    } catch { /* a test double may not implement MouseEvent */ }
  }
}

// Runs inside the meeting page (or a unit-test fake document). Every helper it needs is
// defined inside the function so Puppeteer can copy it into the page as a whole.
function attemptOpenMoreMenu(userId) {
  function snippet(info) {
    // counts and yes/no answers only: never any text from the page (the cloud log is public)
    return [
      'reason=' + (info.reason || 'unknown'),
      'panelOpen=' + (info.panelOpen == null ? 'n/a' : !!info.panelOpen),
      'rows=' + (info.rowCount == null ? 'n/a' : info.rowCount),
      'namedRows=' + (info.namedRowCount == null ? 'n/a' : info.namedRowCount),
      'waiting=' + (info.waiting == null ? 'n/a' : !!info.waiting),
      'hasMoreButton=' + !!info.hasMoreButton,
      'buttonCount=' + (info.buttonCount == null ? 'n/a' : (Number(info.buttonCount) || 0)),
      'inViewport=' + (info.inViewport == null ? 'n/a' : !!info.inViewport),
    ].join(' ')
  }
  function displayName(row) {
    const el = row && row.querySelector && row.querySelector('.participants-item__display-name')
    return String((el && el.textContent) || '').trim()
  }
  function isWaiting(row) {
    const buttons = (row && row.querySelectorAll && row.querySelectorAll('button')) || []
    return [...buttons].some((b) => /^admit$/i.test(String(b.textContent || '').trim()))
  }
  function isMore(btn) {
    if (!btn) return false
    const aria = String((btn.getAttribute && btn.getAttribute('aria-label')) || '').trim()
    const title = String((btn.getAttribute && btn.getAttribute('title')) || '').trim()
    const text = String(btn.textContent || '').trim()
    const popup = String((btn.getAttribute && btn.getAttribute('aria-haspopup')) || '').trim()
    if (/^more options$/i.test(aria)) return true
    if (/^more$/i.test(aria) || /^more$/i.test(text)) return true
    if (/more options|more actions|see more|open more/i.test(aria) || /more options|more actions|see more/i.test(title)) return true
    if (popup === 'menu' && /more/i.test(aria + ' ' + title + ' ' + text)) return true
    return false
  }
  const raw = String(userId || '')
  const at = raw.lastIndexOf('#')
  const name = at > 0 ? raw.slice(0, at) : raw
  const index = at > 0 ? (Number(raw.slice(at + 1)) || 1) : 1
  const rows = [...document.querySelectorAll('.participants-item-position')]
  const panel = document.querySelector('.participants-section-container')
  let panelOpen = !!panel
  try {
    if (panel && panel.getBoundingClientRect) {
      const pr = panel.getBoundingClientRect()
      panelOpen = pr.width > 0 && pr.height > 0
    }
  } catch { /* ignore */ }
  const named = rows.filter((r) => displayName(r) === name)
  const inside = named.filter((r) => !isWaiting(r))
  const row = (inside.length === 1 ? inside[0] : null) || (inside.length >= index ? inside[index - 1] : null) || named[index - 1] || named[0] || null
  if (!row) {
    return { ok: false, reason: 'row-missing', snippet: snippet({ reason: 'row-missing', panelOpen, rowCount: rows.length, namedRowCount: named.length, waiting: false, hasMoreButton: false, buttonCount: 0, inViewport: false }) }
  }
  try { if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest', inline: 'nearest' }) } catch { /* ignore */ }
  for (const type of ['pointerover', 'mouseover', 'mouseenter']) {
    try {
      const ev = typeof MouseEvent === 'function' ? new MouseEvent(type, { bubbles: true, cancelable: true, view: typeof window !== 'undefined' ? window : undefined }) : { type: type }
      if (row.dispatchEvent) row.dispatchEvent(ev)
    } catch { /* ignore */ }
  }
  const buttons = [...(row.querySelectorAll('button, [role=button]') || [])]
  const btn = buttons.find(isMore) || null
  const waiting = isWaiting(row)
  let inViewport = true
  try {
    const rect = btn && btn.getBoundingClientRect ? btn.getBoundingClientRect() : (row.getBoundingClientRect && row.getBoundingClientRect())
    inViewport = !!(rect && rect.width > 0 && rect.height > 0)
  } catch { /* ignore */ }
  if (!btn) {
    return { ok: false, reason: 'no-more-button', snippet: snippet({ reason: 'no-more-button', panelOpen, rowCount: rows.length, namedRowCount: named.length, waiting, hasMoreButton: false, buttonCount: buttons.length, inViewport }) }
  }
  try { btn.click() } catch {
    return { ok: false, reason: 'click-failed', snippet: snippet({ reason: 'click-failed', panelOpen, rowCount: rows.length, namedRowCount: named.length, waiting, hasMoreButton: true, buttonCount: buttons.length, inViewport }) }
  }
  return { ok: true, reason: 'clicked', snippet: snippet({ reason: 'clicked', panelOpen, rowCount: rows.length, namedRowCount: named.length, waiting, hasMoreButton: true, buttonCount: buttons.length, inViewport }) }
}

// Also written to run inside the meeting page as a whole.
function attemptClickMakeHostItem() {
  const item = [...document.querySelectorAll('[role=menuitem], .dropdown-menu a, .dropdown-menu li a, [role=menu] a, [role=menu] button')].find((e) => /^make host$/i.test(String(e.textContent || '').trim()))
  if (item) {
    try { item.click(); return { ok: true, reason: 'clicked-make-host', snippet: 'Make Host item clicked' } } catch { return { ok: false, reason: 'make-host-click-failed', snippet: 'Make Host item was found but the click failed' } }
  }
  return { ok: false, reason: 'no-make-host-item', snippet: 'Make Host item missing' }
}

function makeHostRetryDelays({ budgetMs = DEFAULT_BUDGET_MS, firstDelayMs = DEFAULT_FIRST_DELAY_MS, maxDelayMs = DEFAULT_MAX_DELAY_MS } = {}) {
  const steps = [{ attempt: 1, waitMs: 0 }]
  let used = 0
  let delay = firstDelayMs
  let attempt = 1
  while (used + delay <= budgetMs) {
    used += delay
    steps.push({ attempt: ++attempt, waitMs: delay })
    delay = Math.min(maxDelayMs, delay * 2)
  }
  return steps
}

async function runMakeHostClickLoop({
  openPanel,
  openMenu,
  clickItem,
  sleep,
  dismissMenu,
  budgetMs = DEFAULT_BUDGET_MS,
  afterOpenWaitMs = DEFAULT_AFTER_OPEN_WAIT_MS,
} = {}) {
  const delays = makeHostRetryDelays({ budgetMs })
  let last = { ok: false, reason: 'not-tried', snippet: 'no attempt' }
  for (const step of delays) {
    if (step.waitMs && sleep) await sleep(step.waitMs)
    try { if (openPanel) await openPanel() } catch (e) {
      last = { ok: false, reason: 'panel-closed', snippet: String((e && e.message) || 'Could not open the participants list.') }
      continue
    }
    last = (await openMenu()) || last
    if (last && last.ok) {
      if (afterOpenWaitMs && sleep) await sleep(afterOpenWaitMs)
      const picked = await clickItem()
      if (picked && picked.ok) return { ok: true, last: picked }
      if (dismissMenu) {
        try { await dismissMenu() } catch { /* already closed */ }
      }
      last = picked || { ok: false, reason: 'no-make-host-item', snippet: 'Make Host item missing' }
    }
  }
  return { ok: false, last }
}

function resolveSdkAttendee(attendees, displayName) {
  const wanted = normName(displayName)
  if (!wanted) return { ok: false, reason: 'empty-name', count: 0 }
  const hits = (attendees || []).filter((a) => normName(a && a.userName) === wanted)
  if (hits.length === 1) return { ok: true, userId: hits[0].userId, count: 1 }
  if (hits.length === 0) return { ok: false, reason: 'not-in-sdk-list', count: 0 }
  return { ok: false, reason: 'ambiguous', count: hits.length }
}

function unfinishedHandoverText({ reason, which = '', run = '' } = {}) {
  const stay = ` The bot is staying in the meeting as host: please check it now.${run || ''}`
  if (reason === 'new-host-not-found') {
    return `:warning: Zoom bot: the interview${which} was started but the hand-over did NOT finish (the new host did not join, or could not be told apart).${stay}`
  }
  if (reason === 'host-menu-failed' || reason === 'host-transfer-click-failed') {
    return `:warning: Zoom bot: the interview${which} was started and the new host joined, but the hand-over click failed (${reason}).${stay}`
  }
  return `:warning: Zoom bot: the interview${which} was started but the hand-over did NOT finish (${reason || 'unknown reason'}).${stay}`
}

function errorReportLooksLikeMenuFailure(detail) {
  return /could not open the menu|hand-over click failed|did not offer ["“]Make Host["”]/i.test(String(detail || ''))
}

function menuErrorReportText({ detail, run = '' } = {}) {
  return `:warning: Zoom bot: the new host joined, but the hand-over click failed: ${detail || 'unknown'}. The bot is staying in the meeting as host: please check it now.${run || ''}`
}

module.exports = {
  DEFAULT_BUDGET_MS,
  DEFAULT_AFTER_OPEN_WAIT_MS,
  normName,
  isMoreButton,
  menuFailureSnippet,
  parseUserId,
  rowDisplayName,
  rowIsWaiting,
  pickParticipantRow,
  hoverRow,
  attemptOpenMoreMenu,
  attemptClickMakeHostItem,
  makeHostRetryDelays,
  runMakeHostClickLoop,
  resolveSdkAttendee,
  unfinishedHandoverText,
  errorReportLooksLikeMenuFailure,
  menuErrorReportText,
}
