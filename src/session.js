'use strict'
// The saved Zoom login ("session") travels as ONE text value: the Zoom cookies, compressed and base64-encoded.
// That value is a credential (whoever holds it is signed in as the Zoom account). So this file only encodes,
// decodes and describes it, and nothing here ever prints the value itself.
const zlib = require('zlib')

const MAX_DECODED_BYTES = 256 * 1024
const MAX_ENCODED_CHARS = 48 * 1024 // GitHub refuses a secret larger than 48 KB

// zoom.us and any of its subdomains (".zoom.us", "app.zoom.us", "us06web.zoom.us"), but not "notzoom.us".
const isZoomCookie = (c) => !!c && typeof c.domain === 'string' && /(^|\.)zoom\.us$/i.test(c.domain.replace(/^\./, ''))

// Chrome reports more fields than it accepts back. Keep only what Network.setCookies understands.
function toCookieParams(cookies) {
  return (cookies || []).filter(isZoomCookie).map((c) => {
    const p = { name: String(c.name), value: String(c.value), domain: c.domain, path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly }
    if (['Strict', 'Lax', 'None'].includes(c.sameSite)) p.sameSite = c.sameSite
    if (typeof c.expires === 'number' && c.expires > 0 && !c.session) p.expires = c.expires
    if (c.partitionKey) p.partitionKey = c.partitionKey
    return p
  })
}

function encodeSession(cookies) {
  const zoom = (cookies || []).filter(isZoomCookie)
  if (!zoom.length) throw new Error('No Zoom cookies were found, so there is no signed-in session to save.')
  const text = zlib.gzipSync(Buffer.from(JSON.stringify(zoom), 'utf8'), { level: 9 }).toString('base64')
  if (text.length > MAX_ENCODED_CHARS) throw new Error(`The saved session is ${Math.round(text.length / 1024)} KB, over GitHub's 48 KB secret limit.`)
  return text
}

// Never echoes the input in an error: it may be a real credential that was pasted in the wrong place.
function decodeSession(text) {
  const bad = () => new Error('ZOOM_SESSION is not a valid saved session. Create it again with "npm run export-session".')
  const raw = String(text || '').trim()
  if (!raw) return []
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(raw)) throw bad()
  let cookies
  try {
    const json = zlib.gunzipSync(Buffer.from(raw, 'base64'), { maxOutputLength: MAX_DECODED_BYTES }).toString('utf8')
    cookies = JSON.parse(json)
  } catch { throw bad() }
  if (!Array.isArray(cookies) || !cookies.every((c) => c && typeof c.name === 'string' && typeof c.value === 'string' && typeof c.domain === 'string')) throw bad()
  const zoom = cookies.filter(isZoomCookie)
  if (!zoom.length) throw bad()
  return zoom
}

// Safe to print: counts and dates only, never a name or value.
function describeSession(cookies) {
  const expiries = (cookies || []).filter((c) => typeof c.expires === 'number' && c.expires > 0 && !c.session).map((c) => c.expires * 1000)
  return {
    count: (cookies || []).length,
    soonestExpiry: expiries.length ? new Date(Math.min(...expiries)) : null,
    latestExpiry: expiries.length ? new Date(Math.max(...expiries)) : null,
  }
}

module.exports = { isZoomCookie, toCookieParams, encodeSession, decodeSession, describeSession, MAX_ENCODED_CHARS }
