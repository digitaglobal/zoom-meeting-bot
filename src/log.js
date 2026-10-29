'use strict'
// Log lines carry the time in Jamaica time (the company's time), not the computer's. On a cloud run (quiet) the
// log may be PUBLIC, so links and meeting numbers are masked before anything is printed.

// "https://zoom.us/j/12345678901?pwd=..." -> "[link]";  a 9-12 digit meeting number (spaced or not) -> "[id]"
function scrub(message) {
  return String(message)
    .replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/(?<!\d)\d{3,4}[ -]?\d{3,4}[ -]?\d{3,4}(?!\d)/g, '[id]') // 9-12 digits, even when written "123 4567 8901"
}

function stamp(now, timeZone) {
  const t = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(now)
  return `${t} Jamaica`
}

function makeLog({ quiet = false, timeZone = 'America/Jamaica' } = {}, out = console.log, clock = () => new Date()) {
  return (message) => out(`[${stamp(clock(), timeZone)}] ${quiet ? scrub(message) : message}`)
}

module.exports = { scrub, stamp, makeLog }
