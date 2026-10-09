# api

Vercel serverless functions. Solo rounds are played here; the PWA and both
bots call these endpoints and hold no rules of their own. The rules are in
`../js/rules.js`, a pure module the page shares for party games and replays,
which have no server to ask. `_lib/game.js` imports it, so a solo round and a
replay of it always score the same.

**The answer never leaves the server while a round is live.** A round's
station is a row id in `mrtguessr_rounds`. Replies carry the mask, the hints
bought so far and the score. The station's name appears only once the round
is solved or given up.

## Endpoints

All take and return JSON. Round endpoints need `client_key`: a random id the
browser keeps in local storage, or `tg:<user id>` / `dc:<user id>` from a bot.
A round is only visible to the key that started it.

| Endpoint | Body | Returns |
|---|---|---|
| `POST /api/round/new` | `client_key`, `difficulty?`, `turn_seconds?` | the round view |
| `POST /api/round/guess` | `round_id, client_key, guess` | `correct` plus the round view |
| `POST /api/round/hint` | `round_id, client_key` | `penalty` plus the round view |
| `POST /api/round/state` | `round_id, client_key` | the round view, with due letters revealed |
| `POST /api/round/giveup` | `round_id, client_key` | the round view, with `answer` |
| `POST /api/leaderboard/submit` | `round_id, name` | `name, rank, best_score, total, rounds, total_rank` |
| `POST /api/leaderboard/name` | `name` | `name`, cleaned, or a `400` saying why not |
| `GET /api/leaderboard` | `?board=best` (default) or `?board=total` | `board, entries`, cached 30 s |
| `POST /api/replay/create` | `round_id, client_key, name?` for a solo round, or `replay` for a party game | `id`, for the link `/r/<id>` |
| `GET /api/replay` | `?id=<id>` | `id, kind, verified, created_at, replay`, cached a day |

`state`, `giveup` and `name` are additions to the spec's list: clients poll
`state` at `next_reveal_in` to show letters appearing, `giveup` lets a stuck
player learn the answer, and `name` lets a client check a name it wants to
remember, such as the Telegram bot's saved leaderboard name.

The round view:

```json
{
  "round_id": "…",
  "mask": "T__ P____",
  "length": 8,
  "hint_tier": 2,
  "line_color": "#d42e12",
  "hints": {
    "colors": [{ "hex": "#d42e12", "name": "red" }],
    "codes": ["NS19"],
    "line_names": ["North-South Line"]
  },
  "score": 880,
  "solved": false,
  "gave_up": false,
  "expired": false,
  "next_reveal_in": 9500,
  "next_hint": { "tier": 3, "penalty": 150 },
  "created_at": "…",
  "difficulty": "normal",
  "turn_seconds": 60,
  "time_left": 41500
}
```

`difficulty` is `easy`, `normal` or `hard`, and `turn_seconds` 30, 60, 120 or
`null` for no limit; a round started without them is normal with no limit,
which is what the bots get. `time_left` is null without a limit. A solved
round adds `scoring: { base, difficulty, timer, speed, points, time_ms }`,
the multipliers that turned the base into `score`.

Errors are `{ "error": code, "message"? }` with a matching status: `400` bad
input, `401` bad bot token, `404` no such round, `409` round over or no more
hints or a submission refused by anti-cheat, `410` round or submission
expired.

## Leaderboards

Two boards over the same submissions, one row per name, names compared
case-insensitively:

| Board | Entries | Ranked by |
|---|---|---|
| `best` | `{ rank, name, score }` | the name's single best round; ties to whoever got it first |
| `total` | `{ rank, name, total, rounds }` | every submitted round added up; ties to fewer rounds, then whoever got there first |

Only submitted rounds count towards either, since a round has no name until
it is submitted. Submit returns the name's place on both.

### Anti-cheat

The answer and the score never come from a client, so the cheats left are
scripts. `mrtguessr_submit` refuses two kinds of round with a `409`; the round
still plays and scores as normal, it just stays off the boards:

| Code | Refused when |
|---|---|
| `too_fast` | solved under 3 s after the round started, quicker than a person can read the mask and type |
| `overlap` | its play time overlaps another round already on the board under the same name |

Both are checked in `migrations/004_mrtguessr_anti_cheat.sql`.

## Replays

A replay is the format in `../js/replay-format.js`: the settings, the
players, and per station the letter order and each player's events. Scores
are never stored in it; the player works them out again with `rules.js`.

A solo replay is built here from the stored round, so it is `verified`. A
party replay is whatever the host's page sends, cleaned, with names and
guesses run through the leaderboard's word filter, and is not verified. Both
are kept in `mrtguessr_replays` under an 8 character id, up to 256 KB each.
Like every other endpoint, creating one has no rate limit. Neither stops
a patient script that waits and plays one round at a time.

## Rules

All in `../js/rules.js`. A round stores what the player did as events and the
order its letters show in; everything else is worked out from those and the
time, so reading a round writes nothing.

| | Score |
|---|---|
| Start | 1000 |
| Tier 1, line colour | free, given with the round |
| Tier 2, station codes in full (`NS19`; every code at an interchange) | -100 |
| Tier 3, position on a blank map | -150 |
| Tier 4, Chinese name | -200 |
| Tier 5, one more letter | -60 each |
| A letter from the clock, every 15 s | -60 each |
| Wrong guess | -20 |
| Floor while playing | 50 |

That is the base. A solved round scores the base times its multipliers,
rounded:

| Setting | Clock letter every | Letters stop at | Multiplier |
|---|---|---|---|
| Easy | 10 s | two thirds of the name | × 0.75 |
| Normal | 15 s | half | × 1 |
| Hard | 20 s | a third | × 1.5 |
| No time limit | | | × 1, no speed bonus |
| 2 minutes | | | × 1 |
| 1 minute | | | × 1.2 |
| 30 seconds | | | × 1.5 |
| Speed, with any limit | | | × 1 to × 1.5, by the share of time left |

Letters from the clock and hints together stop at the difficulty's share. A
timed round runs out at its limit, with 2 s of grace for a guess already on
its way; an untimed one expires after an hour. Rounds started before
migration 006 read as expired. Guesses ignore case, spaces, hyphens and accents, so
`toapayoh` is Toa Payoh.

## Auth

Bots send `Authorization: Bearer <BOT_API_TOKEN>`. A wrong token is a `401`,
not a fallback to browser rules. Browsers send nothing. There are no rate
limits.

## Files

| Path | What it is |
|---|---|
| `round/*.js`, `leaderboard/*.js`, `replay/*.js` | The endpoints. |
| `_lib/game.js` | Solo rounds on top of `../js/rules.js`: events, the round view, the solo replay, optimistic updates. |
| `_lib/http.js` | Auth, input checks, error replies. |
| `_lib/names.js` | Leaderboard name cleaning and the English and Chinese word filter. |
| `_lib/lines.js` | Re-exports the line codes, names and colours from `../js/rules.js`. |
| `_lib/supabase.js` | Supabase REST with the service role key. |

Vercel does not route files under `_lib/`.
