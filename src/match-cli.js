#!/usr/bin/env node
'use strict'
// Offline match check. No Zoom, no Slack, no network.
//   node match-cli.js --roster test/unit/fixtures/sample-roster.json --people "Jordan B., Jane Guest"
//     [--exclude-ids U0EXAMPL90,U0EXAMPL91] [--first-id U0EXAMPL01]   (the same as the settings SLACK_ROSTER_EXCLUDE_IDS and FIRST_HOST_SLACK_ID)
//     [--admit-all]   (also say who would be let in if all these names were in the waiting room: the setting ADMIT_ALL_STAFF)
const path = require('path')
const { pickFromPanel, admissibleStaff, describeAdmission } = require('./participants')
const { loadStaffFile, mergeStaff, parseStaffJson, mergeOverrides, emptyOverrides } = require('./staffList')
const { loadRosterFixture, parseSlackIds, isSlackUserId, DEFAULT_EXCLUDED_SLACK_IDS, DEFAULT_FIRST_HOST_SLACK_ID } = require('./slackRoster')

function parseArgs(argv) {
  const out = { people: '', staff: '', json: '', first: '', backups: '', roster: '', excludeIds: '', firstId: '', admitAll: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--people') out.people = argv[++i]
    else if (a === '--staff') out.staff = argv[++i]
    else if (a === '--staff-json') out.json = argv[++i]
    else if (a === '--first') out.first = argv[++i]
    else if (a === '--backups') out.backups = argv[++i]
    else if (a === '--roster') out.roster = argv[++i]
    else if (a === '--exclude-ids') out.excludeIds = argv[++i]
    else if (a === '--first-id') out.firstId = argv[++i]
    else if (a === '--admit-all') out.admitAll = true
    else if (a === '--help' || a === '-h') out.help = true
    else throw new Error(`Unknown option: ${a}`)
  }
  return out
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log('Usage: node src/match-cli.js --roster test/unit/fixtures/sample-roster.json --people "Jordan B., Jane Guest" [--exclude-ids ID,ID] [--first-id ID]')
    return 0
  }
  const names = String(args.people ?? '').split(/[,\r\n]+/).map((s) => s.trim()).filter(Boolean)
  if (!names.length) throw new Error('Give --people with one or more Zoom display names, separated by commas')
  let overrides = emptyOverrides()
  if (args.json) overrides = mergeOverrides(overrides, parseStaffJson(args.json))
  if (args.staff) overrides = mergeOverrides(overrides, loadStaffFile(path.resolve(args.staff)))
  const backups = String(args.backups ?? '').split(/[,;\r\n]+/).map((s) => s.trim()).filter(Boolean)
  const excludeIds = parseSlackIds(args.excludeIds, { defaults: DEFAULT_EXCLUDED_SLACK_IDS, setting: '--exclude-ids' })
  const firstHostSlackId = String(args.firstId || DEFAULT_FIRST_HOST_SLACK_ID).trim()
  if (firstHostSlackId && !isSlackUserId(firstHostSlackId)) throw new Error('--first-id is not a Slack user id')
  let rosterMembers
  if (args.roster) rosterMembers = loadRosterFixture(path.resolve(args.roster), { excludeIds })
  const entries = mergeStaff({
    newHostName: args.first || '',
    backupHostNames: backups,
    overrides,
    rosterMembers,
    firstHostSlackId,
  })
  if (!entries.length) throw new Error('Give --roster, --staff, --staff-json, or --first so there is a staff list to match against')
  const people = names.map((userName, i) => ({ userId: `${userName}#${i + 1}`, userName, isMe: false, isHost: false, waiting: false }))
  const picked = pickFromPanel({ inside: people, outside: [], entries })
  if (args.admitAll) console.log(describeAdmission(admissibleStaff({ people: people.map((p) => ({ ...p, waiting: true })), entries, excludeSlackIds: excludeIds }), { redact: false }))
  if (picked.match) {
    console.log(`Would make ${picked.match.userName} the host (staff "${picked.staff.name}", matched as ${picked.kind}${picked.usedBackup ? ', not first on the list' : ''}).`)
    return 0
  }
  if (picked.ambiguous.length) {
    console.log(`Would not make anyone host: more than one person fits (${picked.ambiguous.map((a) => a.userName).join(', ')}).`)
    return 2
  }
  console.log('Would not make anyone host: no staff member matched those display names.')
  return 2
}

if (require.main === module) {
  try { process.exit(main()) } catch (e) { console.error(`Error: ${e.message}`); process.exit(1) }
}

module.exports = { main }
