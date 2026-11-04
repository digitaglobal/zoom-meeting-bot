'use strict'
// The signed request ("signature") that Zoom's Meeting SDK needs to start a meeting: a standard HS256 token made from the
// SDK app's key and secret. role 1 = host (starts the meeting, together with the host's start key), role 0 = joins as a guest.
// The default is the harmless one: a caller has to ask for the host role.
// The secret never leaves this function and is never printed.
const crypto = require('crypto')

const b64url = (data) => Buffer.from(data).toString('base64url')

function makeSdkSignature({ sdkKey, sdkSecret, meetingNumber, role = 0, nowMs = Date.now(), ttlSeconds = 7200 }) {
  if (!sdkKey || !sdkSecret) throw new Error('The Zoom SDK key and secret are required.')
  if (!/^\d{9,11}$/.test(String(meetingNumber))) throw new Error('That is not a Zoom meeting number.')
  if (role !== 0 && role !== 1) throw new Error('role must be 0 (guest) or 1 (host).')
  // 30 seconds in the past absorbs a slightly slow clock; Zoom needs the token to last at least 30 minutes.
  const iat = Math.floor(nowMs / 1000) - 30
  const exp = iat + Math.max(1800, Math.min(ttlSeconds, 48 * 3600))
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const body = b64url(JSON.stringify({ appKey: sdkKey, sdkKey, mn: String(meetingNumber), role, iat, exp, tokenExp: exp }))
  const sig = crypto.createHmac('sha256', sdkSecret).update(`${head}.${body}`).digest('base64url')
  return `${head}.${body}.${sig}`
}

module.exports = { makeSdkSignature }
