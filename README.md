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
`BACKUP_HOST_NAMES` (optional) lists more people who get host if they are seen before `NEW_HOST_NAME`; see "Backup hosts" below.
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

**Backup hosts (optional).** `NEW_HOST_NAME` is the first choice. A second secret, `BACKUP_HOST_NAMES`, can list more people
(full display names exactly as Zoom shows them, separated by commas or new lines; at most 20). There is no "late" limit:
whoever on the list the bot sees first gets host, so a backup who is already in is made host without waiting for the first
choice. If two people from the list are there at the same check, the **earlier name on the list wins**, so the first choice
always beats a backup (the bot lets the first choice in from the waiting room even if a backup is already inside). Once a
backup has been made host the bot leaves, and a first choice who arrives later is left alone. On a cloud run a one-word
backup name is refused, because it would also fit strangers who share that word. The list is a secret like the host's name:
it is never printed, never given to Chrome, and a public log says only "a backup host" without naming anyone.

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
   (a cloud run refuses to start without it, because a first name alone lets lookalikes fit).
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
  people fit, **even if one is an exact match**, it does nothing rather than guess. It ignores notetaker bots and everyone
  else, and the "Make Host" confirmation (read only from the confirmation dialog) must name exactly the intended person.
- **Known limits (a display name is not an identity):** Zoom shows the bot only names. A guest who has the meeting link
  and types the host's name *first* can be admitted and made host if the real person is not there yet, and a lookalike
  who is already inside is chosen even if the real person is still in the waiting room. The worst case is host of that
  one meeting; it cannot reach the Zoom account's settings, stored recordings or other meetings. Use the **full display
  name** in `NEW_HOST_NAME` and ask the host to join with that name. If the real person and a lookalike are inside at the
  same moment, or the same person is in twice (a second device), the bot does nothing and waits. Every name added to
  `BACKUP_HOST_NAMES` is one more name a guest could type, and a guest who truly has that name (a common one such as
  "Alex Smith") would be made host if they join first, so list only people who are really meant to run the meeting.
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
  - tests (`npm test`) fail if any of these rules is broken, or if a password, token, email address, saved session or
    real-looking meeting number is found in a committed file, and the workflow runs them before every hand-over.

## Tests

| Command | What it checks | Uses real Zoom? |
|---|---|---|
| `npm test` | 70+ offline checks: picking the right person, every hand-over situation with a pretend meeting, the schedule and Jamaica-time rules, the saved-session handling, the log masking, and the repository/workflow safety rules | No |
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
