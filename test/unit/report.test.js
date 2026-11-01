'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { parseReportUrl, runUrlFromEnv, buildReport, sendReport, alreadyReported, markerPath, REPORT_FIELDS } = require('../../src/report')
const { main: reportFailure } = require('../../src/report-failure')
const { runTick } = require('../../src/tick')
const { parseUpcoming } = require('../../src/upcoming')
const { loadConfig, loadDotEnv, ALLOWED_KEYS } = require('../../src/config')

const HOOK = 'https://hooks.example.com/catch/abc123SECRETtoken'
const NOW = new Date(Date.UTC(2026, 10, 1, 19, 20, 0)) // 2:20 PM in Jamaica
const tmpMarker = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-rep-')), 'reported')
const okFetch = (calls) => async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200 } }

test('report address: only a plain https address is accepted', () => {
  assert.equal(parseReportUrl(HOOK), HOOK)
  assert.equal(parseReportUrl('   '), null)
  assert.equal(parseReportUrl(undefined), null)
  assert.equal(parseReportUrl('http://hooks.example.com/x'), null, 'not https')
  assert.equal(parseReportUrl(['https://user:pw', 'hooks.example.com/x'].join('@')), null, 'no login inside the address')
  assert.equal(parseReportUrl('not a url'), null)
})

test('report: a finished hand-over says which interview, when, and how long it took', () => {
  const r = buildReport({ event: 'handover', ok: true, meeting: { title: 'Bea Example Admin Assistant Interview', start: '09:30 AM' }, startedAt: new Date(NOW - 95000), now: NOW })
  assert.equal(r.event, 'handover'); assert.equal(r.ok, true)
  assert.equal(r.interview, 'Bea Example Admin Assistant Interview')
  assert.equal(r.starts, '09:30 AM'); assert.equal(r.seconds, 95)
  assert.equal(r.at, '2026-11-01T19:20:00.000Z')
  assert.equal(r.when, 'Sun, Nov 1, 2:20 PM', 'Jamaica time, whatever the computer\'s zone')
  assert.match(r.text, /:white_check_mark:/); assert.match(r.text, /Bea Example Admin Assistant Interview/)
})

test('report: an unfinished hand-over is a warning that says the bot is still in the meeting', () => {
  const r = buildReport({ event: 'handover', ok: false, reason: 'new-host-not-found', detail: 'The new host did not arrive.', meeting: { title: 'X Interview' }, now: NOW })
  assert.equal(r.ok, false); assert.equal(r.reason, 'new-host-not-found')
  assert.match(r.text, /:warning:/); assert.match(r.text, /did NOT finish/); assert.match(r.text, /staying in the meeting as host/)
})

test('report: a failed run tells how to fix the saved login, and links only to the run page', () => {
  const r = buildReport({ event: 'run-failed', ok: false, now: NOW, runUrl: 'https://github.com/digitaglobal/zoom-meeting-bot/actions/runs/123' })
  assert.match(r.text, /export-session/); assert.match(r.text, /ZOOM_SESSION/)
  assert.equal(r.run, 'https://github.com/digitaglobal/zoom-meeting-bot/actions/runs/123')
})

test('report: links and meeting numbers are masked, control characters and Slack markup are neutralised, long text is cut', () => {
  const title = 'Hi <!channel> & <https://evil.example|click>\u0007' + 'x'.repeat(300)
  const r = buildReport({ event: 'error', ok: false, detail: 'Could not open https://zoom.us/j/1110000003?pwd=zzz for meeting 111 000 0003\nnext line' + 'y'.repeat(300), meeting: { title }, now: NOW })
  assert.ok(!/zoom\.us|1110000003|111 000/.test(JSON.stringify(r)), 'no link and no meeting number')
  assert.ok(!/[\u0000-\u001f]/.test(r.detail) && !/[\u0000-\u001f]/.test(r.interview))
  assert.ok(r.interview.length <= 120 && r.detail.length <= 200)
  assert.match(r.text, /Could not open \[link\] for meeting \[id\]/)
  // the interview title appears in the message of a hand-over report
  const h = buildReport({ event: 'handover', ok: true, meeting: { title }, now: NOW })
  assert.ok(!/<!channel>|<https/.test(h.text), 'cannot ping a channel or build a link through the interview title')
  for (const f of ['interview', 'detail']) assert.ok(!/[<>&]/.test(r[f]), `the ${f} field holds no markup, so wherever it is mapped it cannot ping or link`)
  assert.ok(!/[<>&]/.test(h.interview) && !/<|>/.test(h.text.replace(/:white_check_mark:/, '')))
})

test('report: invisible direction characters are removed and a leading spreadsheet formula character is defused', () => {
  const r = buildReport({ event: 'handover', ok: true, meeting: { title: '=HYPERLINK("x")‮evil​' }, detail: '+cmd⁠ and @mention', now: NOW })
  assert.ok(!/[​-‏‪-‮⁠-⁤﻿]/.test(JSON.stringify(r)))
  assert.ok(r.interview.startsWith("'="), 'a title that starts with = cannot become a formula in a spreadsheet')
  assert.ok(r.detail.startsWith("'+"))
})

test('report: the new host\'s name is hidden in the detail and reason, whatever the case, and whole words only', () => {
  const r = buildReport({ event: 'handover', ok: false, reason: 'Kemal Example did not arrive', detail: '"Kemal Example" did not arrive; 2 people fit (kemal example, KEMAL E, Exampleton)', hostName: 'Kemal Example', now: NOW })
  const all = JSON.stringify(r)
  assert.ok(!/kemal/i.test(all), 'no first name')
  assert.ok(!/\bexample\b/i.test(all), 'no last name')
  assert.match(r.detail, /the new host/); assert.match(r.detail, /Exampleton/, 'a different word that merely starts the same is left alone')
  assert.equal(buildReport({ event: 'error', ok: false, detail: 'plain', hostName: '', now: NOW }).detail, 'plain')
  assert.equal(buildReport({ event: 'error', ok: false, detail: 'x (a+b)', hostName: 'a+b', now: NOW }).detail, 'x (the new host)', 'a name with regex characters cannot break it')
})

test('report: the failed-run message does not claim the login expired; it points to the run page and then explains the login fix', () => {
  const t = buildReport({ event: 'run-failed', ok: false, now: NOW, runUrl: 'https://github.com/o/r/actions/runs/5' }).text
  assert.match(t, /a run FAILED/); assert.match(t, /The run page shows why/); assert.ok(t.includes('https://github.com/o/r/actions/runs/5'))
  assert.doesNotMatch(t, /Most likely the saved Zoom login expired/)
  assert.match(t, /export-session/); assert.match(t, /ZOOM_SESSION/)
})

test('report: a test report says plainly that nothing was started', () => {
  const t = buildReport({ event: 'test', ok: true, meeting: { title: 'TEST - not a real interview', start: '--' }, reason: 'test', detail: 'No interview was started.', startedAt: new Date(NOW - 2000), now: NOW })
  assert.equal(t.event, 'test'); assert.match(t.text, /test report/); assert.match(t.text, /No interview was started/)
  for (const k of ['event', 'ok', 'at', 'when', 'text', 'reason', 'detail', 'interview', 'starts', 'seconds']) assert.ok(k in t, `a test report carries ${k}, so Pabbly can see every field to map`)
})

test('marker: one file per run, inside the runner\'s own temp folder; another run or attempt never sees it', () => {
  const a = markerPath({ RUNNER_TEMP: '/runner/tmp', GITHUB_RUN_ID: '41', GITHUB_RUN_ATTEMPT: '1' })
  assert.equal(path.dirname(a), path.join('/runner/tmp'))
  assert.notEqual(a, markerPath({ RUNNER_TEMP: '/runner/tmp', GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1' }))
  assert.notEqual(a, markerPath({ RUNNER_TEMP: '/runner/tmp', GITHUB_RUN_ID: '41', GITHUB_RUN_ATTEMPT: '2' }))
  assert.equal(path.basename(markerPath({ GITHUB_RUN_ID: '../../etc' })), 'zoom-bot-reported-....etc-1', 'a hostile id cannot walk out of the folder')
  assert.equal(path.dirname(markerPath({})), os.tmpdir())
})

test('failed-run report: a marker left by ANOTHER run does not silence this run\'s alert', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-run-'))
  const calls = []
  const quiet = console.log; console.log = () => {}
  try {
    fs.writeFileSync(markerPath({ RUNNER_TEMP: dir, GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' }), '1') // an earlier run reported
    const env = { REPORT_WEBHOOK_URL: HOOK, RUNNER_TEMP: dir, GITHUB_RUN_ID: '2', GITHUB_RUN_ATTEMPT: '1' }
    assert.equal((await reportFailure(env, { fetchImpl: okFetch(calls) })).sent, true)
    assert.equal((await reportFailure(env, { fetchImpl: okFetch(calls) })).already, true, 'but its own marker does')
    assert.equal(calls.length, 1)
  } finally { console.log = quiet }
})

test('report: only the agreed fields can ever be present (a new field must be added on purpose)', () => {
  const r = buildReport({ event: 'handover', ok: false, reason: 'r', detail: 'd', meeting: { title: 't', start: '09:00 AM' }, startedAt: new Date(NOW - 1000), now: NOW, runUrl: 'https://github.com/a/b/actions/runs/1' })
  for (const k of Object.keys(r)) assert.ok(REPORT_FIELDS.includes(k), `unexpected field ${k}`)
  assert.deepEqual(REPORT_FIELDS, ['event', 'ok', 'at', 'when', 'text', 'reason', 'detail', 'interview', 'starts', 'seconds', 'run'])
})

test('report: the run link is built only from GitHub\'s own run variables and only if it has the expected shape', () => {
  assert.equal(runUrlFromEnv({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'digitaglobal/zoom-meeting-bot', GITHUB_RUN_ID: '42' }), 'https://github.com/digitaglobal/zoom-meeting-bot/actions/runs/42')
  assert.equal(runUrlFromEnv({}), '')
  assert.equal(runUrlFromEnv({ GITHUB_SERVER_URL: 'https://evil.example', GITHUB_REPOSITORY: 'a/b', GITHUB_RUN_ID: '1' }), '')
  assert.equal(runUrlFromEnv({ GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'a/b', GITHUB_RUN_ID: '1/../../x' }), '')
})

test('send: posts the report as JSON to the address, does not follow redirects, and leaves a marker', async () => {
  const calls = []
  const marker = tmpMarker()
  const payload = buildReport({ event: 'handover', ok: true, now: NOW })
  const r = await sendReport(HOOK, payload, { fetchImpl: okFetch(calls), markerFile: marker })
  assert.equal(r.sent, true); assert.equal(calls.length, 1)
  assert.equal(calls[0].url, HOOK); assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(calls[0].init.body), payload)
  assert.equal(alreadyReported(marker), true)
})

test('send: with no address it does nothing at all', async () => {
  const calls = []
  const r = await sendReport(null, {}, { fetchImpl: okFetch(calls) })
  assert.equal(r.skipped, true); assert.equal(calls.length, 0)
})

test('send: a server error is tried once more; a "not found" is not; neither throws, neither leaves a marker', async () => {
  for (const [status, expectedCalls] of [[500, 2], [404, 1]]) {
    const calls = []
    const marker = tmpMarker()
    const lines = []
    const r = await sendReport(HOOK, {}, { fetchImpl: async (u, i) => { calls.push(u); return { ok: false, status } }, markerFile: marker, log: (m) => lines.push(m), sleep: async () => {} })
    assert.equal(r.sent, false); assert.equal(calls.length, expectedCalls)
    assert.equal(alreadyReported(marker), false)
    assert.match(lines.join(' '), new RegExp(`${status}`)); assert.match(lines.join(' '), /hand-over itself is not affected/)
  }
})

test('send: a network failure never throws and the log never contains the address or the error text', async () => {
  const lines = []
  const fetchImpl = async () => { throw new Error(`connect ECONNREFUSED ${HOOK}`) }
  const r = await sendReport(HOOK, {}, { fetchImpl, log: (m) => lines.push(m), markerFile: tmpMarker(), sleep: async () => {} })
  assert.equal(r.sent, false)
  assert.ok(!lines.join('\n').includes('abc123SECRETtoken') && !/hooks\.example\.com|ECONNREFUSED/.test(lines.join('\n')))
  const slow = await sendReport(HOOK, {}, { fetchImpl: async () => { const e = new Error('x'); e.name = 'TimeoutError'; throw e }, log: (m) => lines.push(m), markerFile: tmpMarker(), sleep: async () => {} })
  assert.equal(slow.status, 'timed out')
})

test('failed-run report: sent once, skipped when the bot already reported, skipped with no address, never throws', async () => {
  const env = { REPORT_WEBHOOK_URL: HOOK, GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '7' }
  const calls = []
  const marker = tmpMarker()
  const quiet = console.log; console.log = () => {}
  try {
    assert.equal((await reportFailure({}, { fetchImpl: okFetch(calls), markerFile: marker })).sent, false)
    assert.equal(calls.length, 0, 'no address: nothing sent')
    assert.equal((await reportFailure(env, { fetchImpl: okFetch(calls), markerFile: marker })).sent, true)
    assert.equal(calls.length, 1)
    assert.equal(JSON.parse(calls[0].init.body).event, 'run-failed')
    assert.equal(JSON.parse(calls[0].init.body).run, 'https://github.com/o/r/actions/runs/7')
    const again = await reportFailure(env, { fetchImpl: okFetch(calls), markerFile: marker })
    assert.equal(again.already, true); assert.equal(calls.length, 1, 'the marker from the first report stops a second message')
  } finally { console.log = quiet }
})

test('config: the report address is a setting, only a valid https one is used, and a bad one is flagged without repeating it', () => {
  const base = { ZOOM_USERNAME: 'a@b.com', ZOOM_PASSWORD: 'x' }
  assert.equal(loadConfig(base).reportUrl, null)
  assert.equal(loadConfig(base).reportAddressProblem, false)
  assert.equal(loadConfig({ ...base, REPORT_WEBHOOK_URL: HOOK }).reportUrl, HOOK)
  const bad = loadConfig({ ...base, REPORT_WEBHOOK_URL: 'http://insecure.example.com/x' })
  assert.equal(bad.reportUrl, null); assert.equal(bad.reportAddressProblem, true)
  assert.ok(!JSON.stringify(bad).includes('insecure.example.com'))
  assert.ok(ALLOWED_KEYS.has('REPORT_WEBHOOK_URL'))
})

test('tick: the result of a hand-over carries the meeting (so the report can name the interview)', async () => {
  const page = 'Today\n09:30 AM - 10:00 AM\nBea Example Admin Assistant Interview\nMeeting ID: 111 000 0003\nStart\nChat'
  const driver = { async listUpcoming() { return parseUpcoming(page) } }
  const cfg = loadConfig({ ZOOM_USERNAME: 'a@b.com', ZOOM_PASSWORD: 'x' })
  const deps = { now: () => new Date(Date.UTC(2026, 9, 29, 14, 20)), log: () => {}, runHandover: async () => ({ ok: true, target: {}, info: {} }) }
  const r = await runTick(driver, cfg, {}, deps)
  assert.equal(r.meeting.title, 'Bea Example Admin Assistant Interview')
  assert.equal(r.meeting.start, '09:30 AM')
})

test('source rules: the report address stays out of Chrome and out of every log line', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', '..', 'src', f), 'utf8')
  assert.match(src('browserDriver.js'), /'ZOOM_SESSION', 'ZOOM_PASSWORD', 'ZOOM_USERNAME', 'REPORT_WEBHOOK_URL'/, 'Chrome is started without the report address')
  for (const f of ['cli.js', 'report.js', 'report-failure.js']) {
    // (a message may name the setting; it must never print its value)
    assert.ok(!/(log|console\.\w+)\([^)]*(\.reportUrl|\burl\b|env\.REPORT_WEBHOOK_URL)/.test(src(f)), `${f} must never print the report address`)
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zbot-env-'))
  fs.writeFileSync(path.join(dir, '.env'), `REPORT_WEBHOOK_URL=${HOOK}\nSOMETHING_ELSE=1\n`)
  const env = {}; loadDotEnv(path.join(dir, '.env'), env)
  assert.deepEqual(Object.keys(env), ['REPORT_WEBHOOK_URL'])
})

test('report: the host\'s name is hidden even when the configured name is shorter than the name Zoom shows', () => {
  const r = buildReport({ event: 'handover', ok: false, reason: 'Kemal Example did not arrive', detail: 'Kemal Example is in the room but Kemal Example could not be made host', hostName: ['Kemal', 'Kemal Example'], now: NOW })
  assert.ok(!/kemal|example/i.test(JSON.stringify(r)), 'neither the first name nor the rest of the display name')
  assert.match(r.detail, /the new host/)
})

test('report: a name that sits at the very end of a long message is hidden before the message is cut', () => {
  const r = buildReport({ event: 'error', ok: false, detail: 'x'.repeat(190) + ' Kemal Example', hostName: 'Kemal Example', now: NOW })
  assert.ok(!/kemal|example/i.test(JSON.stringify(r)), 'no half of the name is left at the cut')
})

test('report: in the interview title only the host\'s WHOLE name is hidden (a candidate may share a surname)', () => {
  const same = buildReport({ event: 'handover', ok: true, meeting: { title: 'Example Admin Assistant Interview' }, hostName: 'Kemal Example', now: NOW })
  assert.equal(same.interview, 'Example Admin Assistant Interview')
  const named = buildReport({ event: 'handover', ok: true, meeting: { title: 'Interview with Kemal Example' }, hostName: 'Kemal Example', now: NOW })
  assert.equal(named.interview, 'Interview with the new host')
})

test('report: bidirectional isolates, the Arabic letter mark and soft hyphens are removed too', () => {
  const bad = [0x2066, 0x2067, 0x2068, 0x2069, 0x061c, 0x00ad, 0x200b, 0x202e, 0xfeff].map((c) => String.fromCharCode(c)).join('')
  const r = buildReport({ event: 'handover', ok: true, meeting: { title: `A${bad}B` }, detail: `C${bad}D`, now: NOW })
  assert.equal(r.interview, 'A B'); assert.equal(r.detail, 'C D')
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'report.js'), 'utf8')
  assert.ok(![...source].some((c) => c.charCodeAt(0) > 126), 'the source holds plain ASCII only, so no invisible character can hide in it')
})
