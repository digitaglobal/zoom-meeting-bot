'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { ZoomBrowserDriver } = require('../../src/browserDriver')

// Runs the driver's in-page functions in Node against a pretend Zoom page: the footer button is a TOGGLE (as on the real
// Zoom screen), so a click on an open panel closes it.
const LABEL = 'open the manage participants list pane,5 particpants,2 people are in waiting room'

function pretendZoom(state) {
  const document = {
    querySelector(sel) {
      if (sel === '.participants-item-position') return state.panelOpen && state.rows ? {} : null
      if (sel === '.participants-section-container') return state.panelOpen ? { getBoundingClientRect: () => ({ width: 320, height: 600 }) } : null
      return null
    },
    querySelectorAll(sel) {
      if (sel !== 'button') return []
      return [{
        getAttribute: (n) => (n === 'aria-label' ? LABEL : null),
        click() { state.clicks++; state.panelOpen = !state.panelOpen; state.rows = state.panelOpen },
      }]
    },
  }
  const driver = Object.create(ZoomBrowserDriver.prototype)
  driver.inMeeting = async (fn, ...args) => { globalThis.document = document; try { return fn(...args) } finally { delete globalThis.document } }
  return driver
}

test('participants panel: already showing rows -> no click', async () => {
  const state = { panelOpen: true, rows: true, clicks: 0 }
  await pretendZoom(state).openParticipants(1000)
  assert.equal(state.clicks, 0)
})

test('participants panel: closed -> one click opens it', async () => {
  const state = { panelOpen: false, rows: false, clicks: 0 }
  await pretendZoom(state).openParticipants(1000)
  assert.equal(state.clicks, 1)
  assert.equal(state.panelOpen, true)
})

test('participants panel: open but the rows are briefly missing (Zoom redraws the list) -> waits, never clicks the toggle', async () => {
  const state = { panelOpen: true, rows: false, clicks: 0 }
  setTimeout(() => { state.rows = true }, 600)
  await pretendZoom(state).openParticipants(3000)
  assert.equal(state.clicks, 0, 'a click on an open panel would have closed it')
  assert.equal(state.panelOpen, true)
})

test('participants panel: open but rows never come -> fails after the wait, still without clicking the toggle', async () => {
  const state = { panelOpen: true, rows: false, clicks: 0 }
  await assert.rejects(() => pretendZoom(state).openParticipants(900), /Could not open the participants list/)
  assert.equal(state.clicks, 0)
  assert.equal(state.panelOpen, true)
})

test('participants panel: closed and the click does nothing -> fails after the wait with one click only', async () => {
  const state = { panelOpen: false, rows: false, clicks: 0 }
  const d = pretendZoom(state)
  const real = d.inMeeting
  d.inMeeting = async (fn, ...a) => { const before = state.clicks; const r = await real(fn, ...a); if (state.clicks > before) { state.panelOpen = false; state.rows = false } return r }
  await assert.rejects(() => d.openParticipants(900), /Could not open the participants list/)
  assert.equal(state.clicks, 1)
})
