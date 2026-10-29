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
The first run opens a visible Chrome window once so you can sign in; after that it runs hidden.

## Run it on GitHub (free, every 10 minutes, computer off)

The workflow `.github/workflows/zoom-host-handover.yml` runs `node src/cli.js --tick` every 10 minutes between
06:00 and 19:59 Jamaica time. Each run first runs the tests (no secrets needed), then opens Zoom, reads today's meetings, and:

- **nothing about to start** -> it ends after about a minute and does nothing;
- **a meeting begins within the next 15 minutes**, has not been started yet, and began no more than 5 minutes ago -> it
  starts that meeting as host, lets Kemal in from the waiting room, makes him host, and leaves. Checked every 10 minutes,
  that means a meeting is started 15 to 5 minutes before its start, **about 10 minutes early on average** (GitHub cannot
  promise an exact minute). A meeting that is already running is never touched.

By default only meetings whose title contains **"interview"** are handled. Change that with the repository
variable `MEETING_FILTER` (a pattern; `.*` means every meeting).

> **Repository variables are visible in the run log.** Put only a pattern there, never anything private. The host's name is a
> *secret* (`NEW_HOST_NAME`), so GitHub hides it in the log, and the bot itself never writes it there.
> Use a title convention **you** control for `MEETING_FILTER` (for example a fixed word you put in the title): if a
> public booking page builds titles from what the booker types, a booker could type the word and make the bot start
> their meeting.

### One-time setup

1. **Create the secret.** On a computer where the bot is already signed in to Zoom, run `npm run export-session`.
   It packs the Zoom login into one line of text and copies it to your clipboard (nothing is printed).
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

### Times
Everything is Jamaica time (UTC-5, no daylight saving). Zoom shows meeting times in the account's own time zone, which
must be the same; set `ZOOM_TIMEZONE` otherwise. Log lines are stamped with Jamaica time. The cron hours in the
workflow file are UTC (11:00-00:59 UTC = 06:00-19:59 Jamaica).

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
  same moment, or the same person is in twice (a second device), the bot does nothing and waits.
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
src/config.js          settings
scripts/export-session.js   makes the ZOOM_SESSION value
```

If Zoom changes its web pages, `src/browserDriver.js` (and the list reader in `src/upcoming.js`) are the only files to fix.
