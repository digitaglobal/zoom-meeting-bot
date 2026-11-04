'use strict'
// Zoom's own API, signed in with fixed credentials that never expire (a free "Server-to-Server OAuth" app), so the bot
// needs NO browser login at all (a browser login dies about 15 hours after sign-in, whatever we do). What it uses:
//   token   POST https://zoom.us/oauth/token (grant account_credentials)   -> an access token, good for 1 hour
//   zak     GET  /users/{host}/token?type=zak                                -> the host's short-lived "start key"
//   list    GET  /users/{host}/meetings?type=upcoming | live                 -> which meetings exist
// Nothing here ever prints a credential. An error says which call failed and Zoom's own error text, with e-mail
// addresses and long tokens masked (a cloud log is public).

const API_BASE = 'https://api.zoom.us/v2'
const TOKEN_URL = 'https://zoom.us/oauth/token'

const API_KEYS = ['ZOOM_ACCOUNT_ID', 'ZOOM_S2S_CLIENT_ID', 'ZOOM_S2S_CLIENT_SECRET', 'ZOOM_SDK_KEY', 'ZOOM_SDK_SECRET', 'ZOOM_HOST_EMAIL']

// All six settings, or none (a session login is then used). A partial set is a mistake worth stopping on.
// Never echoes a value: a wrong value may be a real secret pasted into the wrong place.
function parseApiCredentials(env = process.env) {
  const v = Object.fromEntries(API_KEYS.map((k) => [k, String(env[k] ?? '').trim()]))
  if (!API_KEYS.some((k) => v[k])) return null
  const missing = API_KEYS.filter((k) => !v[k])
  if (missing.length) throw new Error(`The Zoom API settings are incomplete. Missing: ${missing.join(', ')}.`)
  const bad = API_KEYS.filter((k) => /\s/.test(v[k]) || v[k].length > 200)
  if (bad.length) throw new Error(`These Zoom API settings have spaces or are too long: ${bad.join(', ')}.`)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.ZOOM_HOST_EMAIL)) throw new Error('ZOOM_HOST_EMAIL must be the e-mail address of the Zoom user who owns the meetings.')
  return { accountId: v.ZOOM_ACCOUNT_ID, clientId: v.ZOOM_S2S_CLIENT_ID, clientSecret: v.ZOOM_S2S_CLIENT_SECRET, sdkKey: v.ZOOM_SDK_KEY, sdkSecret: v.ZOOM_SDK_SECRET, hostEmail: v.ZOOM_HOST_EMAIL }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Zoom's error text, made safe to print: no e-mail addresses, no links, no long token-like strings.
function safeText(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/[^\s@]+@[^\s@]+/g, '[email]')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[token]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 220)
}

// "09:30 AM" in the given zone (a plain space before AM/PM, whatever the Node/ICU version prints)
function clockLabel(ms, timeZone) {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(ms)).replace(/\s/g, ' ')
}

// Zoom's meeting list -> the rows the schedule check already understands (see upcoming.js).
// A meeting that is running now shows Join/End (not startable); anything else listed as upcoming shows Start.
function meetingRows(upcoming, live, { timeZone = 'America/Jamaica' } = {}) {
  const liveIds = new Set((live || []).map((m) => String(m && m.id)))
  return (upcoming || [])
    .filter((m) => m && m.id && typeof m.start_time === 'string' && Number.isFinite(Date.parse(m.start_time)))
    .map((m) => {
      const startMs = Date.parse(m.start_time)
      const id = String(m.id).replace(/\D/g, '')
      return {
        id,
        title: String(m.topic || ''),
        startMs,
        start: clockLabel(startMs, timeZone),
        end: '',
        buttons: liveIds.has(id) ? ['Join', 'End'] : ['Start', 'Chat', 'Edit', 'Delete'],
      }
    })
    .filter((m) => /^\d{9,11}$/.test(m.id))
    .sort((a, b) => a.startMs - b.startMs)
}

function createZoomApi(creds, deps = {}) {
  const doFetch = deps.fetch || globalThis.fetch
  const now = deps.now || Date.now
  const wait = deps.sleep || sleep
  // Called with each runtime-made secret (access token, start key, signature) so a cloud run can register it with GitHub's log masker.
  const mask = (v) => { if (deps.onSecret && v) deps.onSecret(String(v)) }
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64')
  let token = null
  let tokenUntil = 0

  // One HTTP call, retried once on a network error or a 5xx/429 (a timer run should not fail on one blip).
  async function send(label, url, init) {
    let last
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await doFetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(20000) }) // never follow a redirect with a credential attached
        const text = await res.text()
        let body = null
        try { body = text ? JSON.parse(text) : null } catch { body = null }
        if (res.ok) return body || {}
        const detail = body && (body.reason || body.message) ? ` - ${safeText(body.reason || body.message)}` : ''
        const code = body && body.code ? `, Zoom code ${Number(body.code) || safeText(body.code)}` : ''
        last = Object.assign(new Error(`Zoom API: ${label} failed (HTTP ${res.status}${code})${detail}`), { status: res.status })
        if (res.status < 500 && res.status !== 429) throw last
      } catch (e) {
        if (e === last) throw e // a definite answer from Zoom: do not retry
        last = Object.assign(new Error(`Zoom API: ${label} could not be reached (${safeText(e && e.name)}).`), { status: 0 })
      }
      if (attempt < 2) await wait(2000)
    }
    throw last
  }

  async function accessToken() {
    if (token && now() < tokenUntil) return token
    const url = `${TOKEN_URL}?${new URLSearchParams({ grant_type: 'account_credentials', account_id: creds.accountId })}`
    const body = await send('sign in with the app credentials', url, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' } })
    if (!body.access_token || typeof body.access_token !== 'string') throw new Error('Zoom API: sign in with the app credentials gave no access token.')
    token = body.access_token
    mask(token)
    tokenUntil = now() + Math.max(60, Number(body.expires_in) || 3600) * 1000 - 120000
    return token
  }

  async function get(label, path) {
    return send(label, `${API_BASE}${path}`, { method: 'GET', headers: { Authorization: `Bearer ${await accessToken()}` } })
  }

  const user = encodeURIComponent(creds.hostEmail)

  // The host's start key. Short-lived on purpose: a fresh one is fetched for every meeting that is started.
  // ttl: seconds the key lives. A real start needs it to outlast a mid-meeting reconnect; a check that drops it needs almost none.
  async function zak({ ttl = 7200 } = {}) {
    const body = await get('get the host start key', `/users/${user}/token?type=zak&ttl=${Math.max(60, Math.min(Number(ttl) || 7200, 7200))}`)
    if (!body.token || typeof body.token !== 'string') throw new Error('Zoom API: the host start key was empty.')
    mask(body.token)
    return body.token
  }

  async function listMeetings(type) {
    const out = []
    let next = ''
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({ type, page_size: '300' })
      if (next) q.set('next_page_token', next)
      const body = await get(`list ${type} meetings`, `/users/${user}/meetings?${q}`)
      if (Array.isArray(body.meetings)) out.push(...body.meetings)
      next = body.next_page_token || ''
      if (!next) break
    }
    if (next) throw new Error(`Zoom API: the list of ${type} meetings is longer than the bot reads (${out.length}), so it will not guess.`)
    return out
  }

  // Meetings the schedule check can act on, in the same shape as the scraped "Upcoming" list.
  async function upcomingRows(timeZone) {
    const [upcoming, live] = await Promise.all([listMeetings('upcoming'), listMeetings('live')])
    return meetingRows(upcoming, live, { timeZone })
  }

  // Proves every permission the bot needs, without starting anything: sign in, list meetings, and mint (then drop) a start key.
  async function verify(timeZone) {
    const rows = await upcomingRows(timeZone)
    await zak({ ttl: 300 })
    return { meetings: rows.length }
  }

  return { accessToken, zak, listMeetings, upcomingRows, verify, mask }
}

module.exports = { API_KEYS, parseApiCredentials, createZoomApi, meetingRows, clockLabel, safeText }
