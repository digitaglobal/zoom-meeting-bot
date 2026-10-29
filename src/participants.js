'use strict'
// Pure helpers: who is the person to hand host to, and has the hand-over really happened?
// A "person" is { userId, userName, isMe, isHost, waiting } as read from Zoom's participants panel.

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // accents: "Kemál" matches "Kemal"
    .replace(/[^a-z0-9 ]+/g, ' ') // "Kemal-Test" -> "kemal test"
    .replace(/\s+/g, ' ')
    .trim()

// Returns { match } when exactly one person fits, { match: null, ambiguous: [...] } when several do (we then do
// NOTHING rather than guess), and { match: null, ambiguous: [] } when nobody fits. Never picks the bot itself.
// The WHOLE word(s) must appear: "Kemal" fits "Kemal Example" and "Kemal (iPhone)", but not "Kemalettin", and
// never "read.ai meeting notes". An exact match gets NO priority: if a second person also fits (say a guest who typed
// just "Kemal" next to the real "Kemal Example"), the answer is "ambiguous" and nothing is done. Tell the bot the
// person's FULL display name (NEW_HOST_NAME) so that fewer people can fit.
function findNewHost(people, { name }, { excludeUserId } = {}) {
  const candidates = (people || []).filter((p) => p && !p.isMe && String(p.userId) !== String(excludeUserId))
  const n = norm(name)
  if (!n) return { match: null, ambiguous: [] }
  const pick = (list) => (list.length === 1 ? { match: list[0], ambiguous: [] } : list.length > 1 ? { match: null, ambiguous: list } : null)
  const padded = ` ${n} `
  return pick(candidates.filter((p) => ` ${norm(p.userName)} `.includes(padded))) || { match: null, ambiguous: [] }
}

// True only when Zoom itself shows the change: the bot is no longer host, or the target now is.
// If neither is visible we treat it as NOT confirmed (the bot then stays rather than leaving).
function hostTransferred({ people, targetUserId }) {
  const me = (people || []).find((p) => p.isMe)
  if (me && me.isHost === false) return true
  const target = (people || []).find((p) => String(p.userId) === String(targetUserId))
  return !!(target && target.isHost === true)
}

module.exports = { norm, findNewHost, hostTransferred }
