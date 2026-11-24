# Zoom Meeting Bot

Starts a Zoom meeting as **host**, waits for **Kemal**, makes him the **host**, and **drops off**. The meeting keeps
going without the bot. It can run on your computer, or on a free GitHub schedule that checks every 10 minutes and
starts any meeting that is about to begin.

It works the way a person would: a real Chrome signs in to Zoom and uses Zoom's own buttons. It needs no Zoom
Marketplace app and no API keys.

> **This repository is public. It contains no login, no password and no meeting information.** The Zoom login lives
> only in a GitHub *secret* (see "Safety"). Please keep it that way.

## Run it on your computer

```
npm install
npm start                          # a NEW meeting: it prints a link; send that link to Kemal
npm start -- --meeting 123456789   # a meeting that is already on your Zoom schedule
npm run tick:dry                   # what would the schedule check do right now? (starts nothing)
```

Settings go in a `.env` file in this folder (see `.env.example`): `ZOOM_USERNAME`, `ZOOM_PASSWORD`, and optionally
`NEW_HOST_NAME` (default `Kemal`, not case sensitive: "kemal" and "Kemal" both match "Kemal Example". Use the **full display name** as it shows in Zoom, so fewer people can fit).
`BACKUP_HOST_NAMES`, `STAFF_JSON`, `SLACK_ROSTER_TOKEN`, `SLACK_ROSTER_EXCLUDE_IDS` and `FIRST_HOST_SLACK_ID` (all optional) decide who else can be made host; see "Who can be made host" below. `ADMIT_ALL_STAFF` (optional, off) also lets in every waiting staff member; see "Letting in all staff".
The first run opens a visible Chrome window once so you can sign in; after that it runs hidden.

## Run it on GitHub (free, every 10 minutes, computer off)

The workflow `.github/workflows/zoom-host-handover.yml` runs `node src/cli.js --tick` every 10 minutes between
06:00 and 19:59 Jamaica time. Each run first runs the tests (no secrets needed), then opens Zoom, reads today's meetings, and:

- **nothing about to start** -> it ends after about a minute and does nothing;
- **a meeting begins within the next 15 minutes**, has not been started yet, and began no more than 5 minutes ago -> it
  starts that meeting as host, lets Kemal in from the waiting room, makes him host, and leaves. Checked every 10 minutes,
  that means a meeting is started 15 to 5 minutes before its start, **about 10 minutes early on average** (GitHub cannot
  promise an exact minute). A meeting that is already running is never touched.

**Every meeting on the Zoom account is handled, whatever its title.** The cloud workflow fixes `MEETING_FILTER` to `.*` (a repository
variable cannot narrow it). Locally, `MEETING_FILTER` in `.env` can still limit a run to titles matching a pattern.

> The host's name is a *secret* (`NEW_HOST_NAME`), so GitHub hides it in the log, and the bot itself never writes it there.

### Who can be made host

`NEW_HOST_NAME` is the first choice. Everything else here is optional and only **adds** people. The bot keeps one ordered list
and takes the **first person on it who is seen**: an earlier name beats a later one, even if the later one is already inside
(the first choice is let in from the waiting room even if someone further down the list is already in the meeting). Once someone
has been made host the bot leaves, and anyone who arrives later is left alone. On a cloud run no name is printed: the public log
says only "the new host" (on your own computer the log does show names).

| Setting | Where | What it does | If empty |
|---|---|---|---|
| `NEW_HOST_NAME` | GitHub secret, or `.env` | The first choice: the host's **full display name** as Zoom shows it. With the Slack list on, this person is first in line unless `FIRST_HOST_SLACK_ID` names someone else. | Locally the built-in default `Kemal`. A **cloud run refuses to start**. |
| `BACKUP_HOST_NAMES` | secret / `.env` | More people (full names, separated by commas or new lines, at most 20). **A fail-safe only:** used when the Slack list is off or cannot be read. A one-word name is refused on a cloud run. | No backups |
| `SLACK_ROSTER_TOKEN` | secret / `.env` | A read-only Slack token (`xoxb-...`). Turns the live Slack list on: every active member can be made host. | The Slack list is off |
| `SLACK_ROSTER_EXCLUDE_IDS` | secret / `.env` | Slack user ids, separated by commas, to leave out: shared or test accounts that are not people, for example `U0EXAMPL90,U0EXAMPL91`. Ids only, never a token. | **Nobody is skipped** (see the warning below) |
| `FIRST_HOST_SLACK_ID` | secret / `.env` | The Slack user id of the person who is first in line when the Slack list is on, for example `U0EXAMPL01`. | The person named in `NEW_HOST_NAME` is first, matched by name |
| `ADMIT_ALL_STAFF` | secret / `.env` | `true` = while the bot is host, let **every** staff member in from the waiting room, not only the one who is made host (see "Letting in all staff" below). Needs the Slack list on to know who the staff are. | **Off**: only the new host is let in |
| `STAFF_JSON` or `STAFF_LIST_PATH` | secret (the JSON itself) / `.env` (a file path) | Extra rules in JSON: a plain list of names, or an object (see "Extra rules" below). | No extra rules |

These are secrets like the host's name: never given to Chrome and never committed (a test fails if a Slack-id-shaped value is
found in the repository). The Slack token never appears in any log or error message.

**The live Slack list (optional).** Put a read-only token in `SLACK_ROSTER_TOKEN`. Make a small Slack app of its own with the
permission `users:read` and nothing else: do **not** reuse a bot token that can also post or read channels. The bot reads the member
list **once at the start of each run** (one call, kept for that run), so someone deactivated in Slack drops off and a new colleague
is added with no setting to change. Left out: deactivated people, bots, Slackbot, **guests**, and every id in
`SLACK_ROSTER_EXCLUDE_IDS`. A person's name is their Slack full name or display name, whichever has more words; a member whose name is a single word is left off the list (a bare first name is never matched). The order is: the
first host (`FIRST_HOST_SLACK_ID`, else the person named in `NEW_HOST_NAME`), then anyone in `priority` (see below), then everyone
else in the order Slack returns them. With the list on, **it is the whole source of truth**: `BACKUP_HOST_NAMES` and the `people` in
`STAFF_JSON` do not add anyone (a `people` entry can still give aliases to someone who is on the Slack list). If Slack cannot be
read, the bot carries on with the fixed names (`NEW_HOST_NAME`, then `BACKUP_HOST_NAMES`, then the `people` in `STAFF_JSON`), logs
only Slack's own error code (never a name or the token), and tries Slack again about 10 minutes later while it waits.

> **Set `SLACK_ROSTER_EXCLUDE_IDS` before the Slack list is turned on.** No id is built into this public code, so with the setting
> empty **nobody is skipped**: a shared account (a "Front Desk" or test login that is not a person) counts as staff and could be
> made host. The bot does not refuse to start without it. Switch the list on in this order: (1) deploy the code, (2) set
> `NEW_HOST_NAME` and `SLACK_ROSTER_EXCLUDE_IDS` (and `FIRST_HOST_SLACK_ID` if you want a fixed first host), (3) run the offline
> checks below, (4) add `SLACK_ROSTER_TOKEN` **last**.

**Extra rules: `STAFF_JSON` / `STAFF_LIST_PATH` (optional).** Either a plain list of names, or an object like this (see
`staff.json.example`; the names and ids here are made up):

```json
{
  "firstHostSlackId": "U0EXAMPL01",
  "priority": ["Avery Stone", "U0EXAMPL04"],
  "excludeIds": ["U0EXAMPL90"],
  "aliases": { "Jordan Banks": ["J Banks"], "U0EXAMPL03": ["Dana G"] },
  "people": [{ "name": "Jordan Bishop" }]
}
```

- `firstHostSlackId`: the same as `FIRST_HOST_SLACK_ID`.
- `priority`: people moved up the list, right after the first host (a full name or a Slack id).
- `excludeIds`: added to `SLACK_ROSTER_EXCLUDE_IDS`.
- `aliases`: other names a person may join under, keyed by their Slack id or full name. Each alias needs **two or more words** (for example "Dana G"): a one-word alias is ignored.
- `people`: the fail-safe list used when the Slack list is off or cannot be read (a plain list of names means the same thing).
- **Any other key is rejected** with an error, never ignored: a misspelt `excludedIds` that was silently dropped would leave a shared account eligible as host. `excludeIds` may also be written `exclude_ids`, as a list or a comma separated string.

**How a Zoom name is matched.** Names are compared ignoring capital letters, accents and punctuation. With the Slack list on, a
person (say "Avery Stone") is recognised when their Zoom display name is:

- their full name, alone or followed by a device word or a note in brackets: "Avery Stone", "Avery Stone (iPhone)", "Avery Stone (Marketing)";
- their first name and last initial, alone or with a device word or a note in brackets: "Avery S", "Avery S.", "Avery S. (iPad)"; or
- a Slack display name of two or more words.

**A bare first name never matches.** "Dana", "dana" or "Dana (iPhone)" is not enough, not even when nobody else on the list has
that first name, and a one-word alias or nickname is ignored. The minimum is **first name plus last initial**. A last name that
only *starts* with that letter does not count either: "Avery Smith" and "Dana Green" do not match Avery Stone and Dana Gray, and
neither does "Dana G. Lopez" (a middle initial). **Any other word before or after the name means somebody else**: "Dr Avery Stone", "Avery Stone Johnson" and "Avery Stone - Ops" do not match, and a candidate called "Maria Lopez Garcia" is not the staff member "Maria Lopez" (a note in brackets is fine; a middle name left out is too: "Mary Smith" fits Mary Ann Smith). A display name longer than 200 characters never matches. A Slack member whose name is a single word is left off the list. **A better fit
beats a weaker one**: the real "Avery Stone" (also as "Avery Stone (iPhone)") always beats a guest who joined as "Avery S", so the
real person is never pushed aside. If **two people fit equally well** (two guests who both joined as "Avery S", or one person joined
twice from two devices), the bot does nothing and waits rather than guess. For the same reason "Jordan B." is refused when two
staff names (Jordan Banks and Jordan Bishop) both fit it, with the Slack list on or off.

### Letting in all staff (`ADMIT_ALL_STAFF`, off by default)

Normally the bot lets in **one** person: the one it is about to make host. Everyone else who arrives waits in the waiting room
for the new host to let them in. With `ADMIT_ALL_STAFF=true` (the GitHub secret of the same name) the bot also lets in **every
staff member who is waiting**, each time it looks at the waiting room (about every 2 seconds), for as long as it is the host.
To switch it off again, set the secret to `false` or delete it: no code change either way.

What does **not** change: who gets host. The order is the same as before (the first choice, then the rest of the list), and the
bot still leaves as soon as Zoom shows the new host. Staff who arrive **after** that are not let in by the bot, because it has gone.

A waiting person is let in only when **all** of these are true:

- **They are staff, by the same name rules as the hand-over** (see "How a Zoom name is matched"): the full name, or first name plus
  last initial, in any capitals, optionally followed by a device word or a note in brackets: "Avery Stone", "dana gray", "Jules R.",
  "Riley Mason (iPhone)". A **bare first name is never enough** ("Avery", "Dana (iPhone)"), and neither are extra words ("Dr Avery
  Stone", "Avery Stone - Ops") or a last name that merely starts with the same letter ("Avery Smith").
- **Exactly one staff member fits.** If the name could be two staff ("Jordan B" when both a Jordan Banks and a Jordan Bishop work
  here, or two staff with the very same full name), nobody is let in and the log says so once. The bot does not guess.
- **Nobody else present fits that same staff member at all.** Two people who both joined as "Avery S", one person who joined twice
  (two devices), or an "Avery S" or "Avery Stone (iPhone)" next to the real "Avery Stone", cannot be told apart from a lookalike, so
  neither is let in until only one is left. The new host can always let a held person in by hand.
- **They are not excluded.** An account in `SLACK_ROSTER_EXCLUDE_IDS` (a "Front Desk" or test login) is not on the Slack list at
  all, so even its own full name never gets it in. Guests and bots stay in the waiting room too.

Other details: a staff name typed by hand as a single word (the old `NEW_HOST_NAME` default) is not used for this, because a
bare first name is not enough; with **no** Slack list (`SLACK_ROSTER_TOKEN` empty, or Slack unreadable) only the fixed host names
(`NEW_HOST_NAME`, `BACKUP_HOST_NAMES`, the `people` in `STAFF_JSON`) count as staff, and the run says so. The person
who is about to be made host is always let in **first**; the others follow a moment later. If that click fails (they just left, or the
panel moved) the bot looks again, and three failures in a row end the run with an error, exactly as before. A click on anyone else
that does not take is retried at most 3 times, 15 seconds apart, and a click that fails is logged and **never stops the hand-over**. A
dry run (`--dry-handover`) only says who it would let in. The public log says "a staff member", never a name or a number. Any
value other than `true`/`1`/`yes`/`on` leaves the setting **off**; an unclear value (a typo such as `ture`) is reported in the
log instead of being guessed.

**Check it before a real meeting.** These start nothing and need no Zoom login:

```
node src/cli.js --who-would-host --people "Avery S., Jane Guest"      # judged by YOUR settings (NEW_HOST_NAME, STAFF_JSON, ...)
node src/cli.js --who-would-host --roster test/unit/fixtures/sample-roster.json --people "Avery S., Jane Guest"
node src/match-cli.js --roster test/unit/fixtures/sample-roster.json --exclude-ids U0EXAMPL90,U0EXAMPL91 --first-id U0EXAMPL01 --people "Avery S., Front Desk"
node src/match-cli.js --roster test/unit/fixtures/sample-roster.json --exclude-ids U0EXAMPL90,U0EXAMPL91 --first-id U0EXAMPL01 --people "Avery S., Front Desk, Dana, Dana Gray" --admit-all
node src/cli.js --meeting <number> --dry-handover
```

- `--who-would-host` uses the settings in force (`NEW_HOST_NAME`, `BACKUP_HOST_NAMES`, `STAFF_JSON`, the exclusions). With
  `SLACK_ROSTER_TOKEN` set and no `--roster` it makes one read-only call to Slack; with `--roster <file>` it uses a local copy of a
  member list instead (a JSON list of `{ "slackId", "name", "displayName" }`, see `test/unit/fixtures/sample-roster.json`) and
  calls nothing. It prints `Would make ... the host` (exit code 0) or `Would not make anyone host` (exit code 2).
- `src/match-cli.js` does the same with every setting given as an option (`--first`, `--backups`, `--staff-json`, `--staff`,
  `--roster`, `--exclude-ids`, `--first-id`), so nothing is read from the environment or `.env`. Try it **without**
  `--exclude-ids` to see what an empty exclusion list lets through.
- `--admit-all` (on `match-cli.js`) also prints who would be let in if all the given names were in the waiting room at once, and
  who would be refused (the same line is printed by `--who-would-host` when `ADMIT_ALL_STAFF` is on).
- `--dry-handover` joins a real meeting and logs who it would admit and make host, but never clicks Admit or Make Host.
  With `ADMIT_ALL_STAFF` on it also logs each staff member it would let in.
- On Windows PowerShell put JSON in an environment variable (`$env:STAFF_JSON = '[{"name":"Jordan Banks"}]'`) or in a file:
  PowerShell strips the quotes inside a command-line argument, so `--staff-json '[...]'` fails with "not valid JSON".

### One-time setup

1. **Create the secret.** On a computer where the bot is already signed in to Zoom, run `npm run export-session`.
   It packs the Zoom login into one line of text and copies it to your clipboard (nothing is printed).
   If the bot is not signed in (or the login has expired), open the bot's own browser at Zoom's sign-in page with
   `npm start -- --headed`, sign in by hand with email and password, and **tick "Stay signed in"** before you submit.
   **Warning (checked 2026-11-03): the tick does NOT make the login last.** Zoom ends the login about 15 hours after
   sign-in, and the "remember me" cookies (about 90 days) do not bring it back, in the cloud or on a PC. Until a permanent
   fix is in place the login must be renewed at least every ~14 hours (see PROJECT_NOTES.md section 12).
2. **Add it to GitHub:** *Settings -> Secrets and variables -> Actions -> New repository secret*, name `ZOOM_SESSION`,
   paste. Then delete `~/.zoom-meeting-bot/session.b64`.
3. **Fork protection:** *Settings -> Actions -> General -> "Fork pull request workflows from outside collaborators"*
   -> **Require approval for all outside collaborators**. Leave "Workflow permissions" on **Read repository contents**.
4. **Repository hygiene:** no collaborators, two-factor sign-in on the GitHub account, branch protection on `main`.
   Never switch this workflow to a **self-hosted** runner: a public repository must only use GitHub's own runners.
5. **The host's name:** a second secret, `NEW_HOST_NAME` = the host's **full display name exactly as Zoom shows it**
   (a cloud run refuses to start without it, because a first name alone lets lookalikes fit). To let more people be made host,
   see "Who can be made host" above: set the optional secrets there in the order it gives, with `SLACK_ROSTER_TOKEN` last.
6. **Try it:** *Actions -> Zoom host hand-over -> Run workflow* (leave "dry run" ticked first).

If Zoom ever signs the bot out, a run fails with "the saved session has probably expired": repeat steps 1-2.
GitHub also switches scheduled workflows off in a public repository after 60 days with no activity; it emails you,
and one click on **Enable workflow** turns it back on.

### Timers and reports (optional, recommended)

GitHub's own schedule is not exact: it can start a run late or skip one. So an outside timer (the owner's Pabbly) starts runs
on time by asking GitHub to run this workflow (`workflow_dispatch`, with a fine-grained token that can run workflows in this one
repository and nothing else):

- **One run 10 minutes before each booked interview** (`dry_run` false).
- **A login check every hour** (`dry_run` true): it only looks at Zoom. If the saved login has expired it fails, and the owner
  hears about it hours before an interview instead of at the interview.
- GitHub's own 10-minute schedule stays as a backup. A run only starts a meeting that is really due on Zoom's schedule,
  so a duplicate or stale timer does nothing.

The optional secret `REPORT_WEBHOOK_URL` (an https address) makes the bot send a **private report** after every real hand-over
(done, or not finished) and when a run fails. A report holds: what happened, when, how long it took, and the interview title
(so the owner knows which one). It never holds a login, a link, a meeting number or the new host's name, and the address is
never printed in any log. If a report cannot be delivered, the hand-over is not affected. The backup schedule does not send
plain error reports (they would repeat every 10 minutes); the hourly check does.

To check that reports arrive: *Actions -> Zoom host hand-over -> Run workflow* with **Send one test report** ticked. It opens no
Zoom and starts nothing; it only sends a report titled "TEST - not a real interview". (Locally: `node src/cli.js --test-report`.)

### Times
Everything is Jamaica time (UTC-5, no daylight saving). Zoom shows meeting times in the account's own time zone, which
must be the same; set `ZOOM_TIMEZONE` otherwise. Log lines are stamped with Jamaica time. The cron hours in the
workflow file are UTC (11:00-00:59 UTC = 06:00-19:59 Jamaica).

## No login at all (the permanent fix, free)

A Zoom *login* dies about 15 hours after sign-in, whatever "Stay signed in" says (checked 2026-11-03: three logins, and the
"remember me" cookies cannot bring it back). So the bot can instead use Zoom's own API credentials, which never expire and cost
nothing. Each run it asks Zoom for the meeting list and for a fresh 2-hour "host start key" and starts the meeting through
Zoom's Meeting SDK (`src/sdkDriver.js`). No password, no captcha, no saved login. When all six settings below are present they
are used instead of `ZOOM_SESSION`; with none of them set, everything works as before.

**One-time setup (a Zoom account owner or admin, about 10 minutes).** Zoom changes its Marketplace screens now and then; if a
name below differs slightly, pick the closest one.
1. Sign in at <https://marketplace.zoom.us> with the Zoom account, then **Develop -> Build App**. No "Develop" menu means this
   user is not an admin of the Zoom account: hand these steps to whoever is.
2. Build a **Server-to-Server OAuth** app (any name, for example "Interview host bot"). Copy its **Account ID**, **Client ID** and
   **Client Secret**. Under **Scopes** add: `user:read:zak:admin`, `user:read:token:admin`, `meeting:read:list_meetings:admin`
   (if Zoom says another scope is missing, the bot's error message names it). Then **Activate** the app.
3. Build a **General App** with **Meeting SDK** switched on (menu "Embed" -> "Meeting SDK"; older screens call this app type
   "Meeting SDK"). Placeholder URLs (for example `https://example.com`) are fine for the required URL fields: it is only used by
   your own account. Copy its **Client ID** (= SDK key) and **Client Secret** (= SDK secret) from "App Credentials" (Development).
4. The 6 values, plus the e-mail address of the Zoom user who owns the interview meetings (the account the bot used to log in as):

   | setting | value |
   |---|---|
   | `ZOOM_ACCOUNT_ID` | Account ID (app 1) |
   | `ZOOM_S2S_CLIENT_ID` / `ZOOM_S2S_CLIENT_SECRET` | Client ID / Client Secret (app 1) |
   | `ZOOM_SDK_KEY` / `ZOOM_SDK_SECRET` | Client ID / Client Secret (app 2) |
   | `ZOOM_HOST_EMAIL` | the meetings' owner |

   Locally: put them in `.env` (see `.env.example`; the file is git-ignored). On GitHub: **Settings -> Secrets and variables ->
   Actions -> New repository secret**, one secret per name. Never paste them in a chat, an issue or a commit.
5. Check, starting nothing: `npm run check:sdk` (Zoom's SDK page starts in Chrome; needs no credentials) and `npm run tick:dry`
   (prints "The Zoom API credentials work" when sign-in, the meeting list and the host start key all succeed).
6. One real test: book a test meeting a few minutes ahead, then `node src/cli.js --meeting <its number> --headed`, join as the new host.

**What to know about these credentials (security review, 2026-11-03).**
- They never expire, so they are worth more than the old login cookie. The Server-to-Server app's scopes cover the whole Zoom account (it
  could issue a start key for any user), so treat the six values like a password, rotate them if they ever leak (regenerate the secret in the
  Marketplace app, update the GitHub secret), and never reuse them elsewhere.
- Residual risk, accepted for now: on GitHub the bot's Chrome runs without its sandbox and Chrome renders content from other meeting
  participants, so a Chrome exploit could read the bot's environment. Chrome itself is started without any `ZOOM_*` value. Options to
  shrink it later: re-enable Chrome's sandbox on the runner, or split the run so the step with Chrome only gets the short-lived start key.
- Zoom's SDK script is loaded from Zoom (`source.zoom.us`) at one pinned version (`src/sdkPage.js`). Zoom receives the start key anyway,
  but review the pin now and then, because Zoom retires old versions.
- The API credentials are read only from this folder's `.env` or the environment, never from the parent app's `../.env.local` (that file
  uses some of the same names for a different Zoom app). This folder sits in OneDrive, so `.env` syncs to the cloud like `.profile/` does.

Unproven until the first live run with real credentials (2026-11-03): that Zoom's SDK meeting screen has the same buttons the bot
presses (participants list, Admit, Make Host, Leave); the `npm run check:sdk` result only proves the SDK page starts. If a selector
differs, `src/browserDriver.js` is the one file to adjust. The hand-over rules and their tests are unchanged.

## Safety (on purpose)

- It **never ends the meeting for everyone.** The only leave button it can press is the plain "Leave Meeting", and only
  after Zoom shows Kemal as host. A test checks the source can never contain an "end for everyone" click.
- It only **admits and promotes the person whose name matches.** "Kemal" matches "Kemal Example", not "Kemalettin". If two
  people fit equally well, **even if one is an exact match** of a one-word name, it does nothing rather than guess; with a
  full name a better fit beats a weaker one (see "How a Zoom name is matched"). It ignores notetaker bots and everyone
  else, and the "Make Host" confirmation (read only from the confirmation dialog) must name exactly the intended person.
- **Known limits (a display name is not an identity):** Zoom shows the bot only names. A guest who has the meeting link
  and types the host's name *first* can be admitted and made host if the real person is not there yet, and a lookalike
  who is already inside is chosen even if the real person is still in the waiting room. The worst case is host of that
  one meeting; it cannot reach the Zoom account's settings, stored recordings or other meetings. Use the **full display
  name** in `NEW_HOST_NAME` and ask the host to join with that name. If the real person and a lookalike fit equally well, or
  the same person is in twice (a second device), the bot does nothing and waits. Every name added to
  `BACKUP_HOST_NAMES` is one more name a guest could type, and a guest who truly has that name (a common one such as
  "Alex Smith") would be made host if they join first, so list only people who are really meant to run the meeting.
  **With the Slack list on, every active member is such a name, in two forms** (the full name, and first name plus last initial
  such as "Avery S."): a stranger who joins as "Avery S." while that person is absent can be admitted and made host, so the worst
  case is someone who happens to share a first name and last initial. A bare first name, or a longer last name that merely starts
  with the same letter, never matches. Keep the Slack workspace to people who may run a meeting, leave guests as guests (they
  are skipped), put shared accounts in `SLACK_ROSTER_EXCLUDE_IDS`, and ask hosts to join with their full name. (A one-word name
  typed by hand, such as the old default `Kemal`, still matches as a whole word: use a full name.)
- **With `ADMIT_ALL_STAFF` on, a display name also opens the door.** A guest who has the meeting link and types a colleague's
  exact full name, or first name and last initial ("Avery S"), is let in from the waiting room while the bot is host (not made
  host: that still follows the rules above). Zoom shows the bot only names, so this cannot be told apart from the real colleague.
  It is **off by default** for that reason; switch it on only if letting in a name-only lookalike is acceptable for your
  meetings (an interview is a closed conversation: judge that before turning it on). Two people who fit the same colleague (the same name,
  or a lookalike next to the real person) are held back rather than let in, and the new host can always remove anyone.
- If Kemal never arrives, or Zoom does not confirm the change, **the bot stays in the meeting as host** (on your computer
  until you press Ctrl+C; on GitHub until the run's 70-minute limit stops it, and the run is marked failed from the start,
  even if the browser dies). Until that limit it does not leave the meeting without its host, and it never claims success
  it did not see.
- **Heads-up about a stuck run:** GitHub runs one hand-over at a time (the Zoom account can only host one meeting at once).
  While a run is stuck waiting, later interviews are **not** started, and nobody is told until the stuck run fails, up to
  70 minutes later. It gets stuck when the host never joins, joins from two devices, or a lookalike is in the meeting.
  Watch the first few interviews. Worth adding later: an alert (for example a Slack message) when a run has waited 15 minutes.
- **Nothing sensitive can leak from a public repository:**
  - the workflow is started only by the schedule or a manual click, never by a pull request, so nobody else's code
    ever runs with the login;
  - it can only *read* the repository, uses no caches and no artifacts, and every GitHub action it uses is pinned to an
    exact commit;
  - the cloud log is public, so it **masks links and meeting numbers and never prints meeting titles, people's names,
    the password or the saved session**, and it does not say how many meetings there are or when they start (it says
    only whether one is due, so the run times themselves still hint at when interviews happen); screenshots are switched
    off in the cloud, and anything that escapes as an error goes through the same mask;
  - the saved login is only ever read from the secret (`ZOOM_SESSION`) and never logged. Chrome is started without it in
    its own environment as a precaution, but the bot's process still holds it and Chrome runs without its sandbox on the
    runner, so the residual risk is a Chrome exploit delivered through Zoom's own pages; Chrome keeps its cookie store in
    a throw-away folder that disappears with the runner;
  - env files are read only for the bot's own settings (anything else in them is ignored);
  - tests (`npm test`) fail if any of these rules is broken, or if a password, token, email address, saved session,
    real-looking meeting number or real-looking Slack user id is found in a committed file, and the workflow runs them before every hand-over.

## Tests

| Command | What it checks | Uses real Zoom? |
|---|---|---|
| `npm test` | 320+ offline checks: picking the right person (full names, first name and last initial, the Slack list and its exclusions, all with made-up names), letting in every waiting staff member (`ADMIT_ALL_STAFF`), every hand-over situation with a pretend meeting, the schedule and Jamaica-time rules, the saved-session handling, the log masking, and the repository/workflow safety rules | No |
| `npm run test:live` / `test:live-cli` | the real hand-over with a second browser playing "Kemal-Test" | **Yes** (starts a short real meeting, always ends it) |
| `npm run test:live-scheduled -- --meeting <number> --yes` | starting a meeting that is on the schedule | **Yes** |
| `npm run test:live-tick -- --meeting <number> --title "<text>" --yes` | the whole cloud flow (empty profile, saved session only, no password, quiet log) | **Yes** |

Every live test refuses to run while any meeting on the account is in progress. They end only the test meeting they
started themselves (a test-only step; the bot itself can never end a meeting).

## Files

```
src/cli.js             the command
src/tick.js            one schedule check
src/upcoming.js        reads Zoom's "Upcoming" list; decides which meeting is due (Jamaica time)
src/handover.js        the step-by-step job and its safety rules (testable without Zoom)
src/participants.js    picking the right person; checking the host change happened
src/staffList.js       who can be made host: the fixed names, the extra rules (STAFF_JSON) and the order
src/slackRoster.js     reads the active member list from Slack (read-only, once per run)
src/makeHostMenu.js    opening a person's menu to make them host, with retries
src/match-cli.js       the offline "who would get host?" check (no Zoom, no Slack needed)
src/browserDriver.js   everything that touches Zoom's screens (selectors live here)
src/session.js         the saved login as one text value (encode, decode; never printed)
src/stay.js            what the bot does when it cannot finish: stay as host, and fail the run if the browser dies
src/log.js             Jamaica-time stamps and the public-log masking
src/report.js          the private "what happened" report (address from the secret REPORT_WEBHOOK_URL)
src/report-failure.js  sends the "run failed" report from the workflow
src/config.js          settings
scripts/export-session.js   makes the ZOOM_SESSION value
```

If Zoom changes its web pages, `src/browserDriver.js` (and the list reader in `src/upcoming.js`) are the only files to fix.
