# api

Vercel serverless functions. The only place game rules exist; the PWA and
both bots call these endpoints and hold no rules of their own.

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
| `POST /api/round/new` | `client_key` | the round view |
| `POST /api/round/guess` | `round_id, client_key, guess` | `correct` plus the round view |
| `POST /api/round/hint` | `round_id, client_key` | `penalty` plus the round view |
| `POST /api/round/state` | `round_id, client_key` | the round view, with due letters revealed |
| `POST /api/round/giveup` | `round_id, client_key` | the round view, with `answer` |
| `POST /api/leaderboard/submit` | `round_id, name` | `name, rank, best_score` |
| `GET /api/leaderboard` | | `entries: [{ rank, name, score }]`, cached 30 s |

`state` and `giveup` are additions to the spec's list: clients poll `state`
at `next_reveal_in` to show letters appearing, and `giveup` lets a stuck
player learn the answer.

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
    "code_prefixes": ["NS"],
    "line_names": ["North-South Line"]
  },
  "score": 880,
  "solved": false,
  "gave_up": false,
  "expired": false,
  "next_reveal_in": 9500,
  "next_hint": { "tier": 3, "penalty": 150 },
  "created_at": "…"
}
```

Errors are `{ "error": code, "message"? }` with a matching status: `400` bad
input, `401` bad bot token, `404` no such round, `409` round over or no more
hints, `410` round or submission expired, `429` rate limited.

## Rules

All in `_lib/game.js`.

| | Score |
|---|---|
| Start | 1000 |
| Tier 1, line colour | free, given with the round |
| Tier 2, code prefix | -100 |
| Tier 3, position on a blank map | -150 |
| Tier 4, Chinese name | -200 |
| Tier 5, one more letter | -60 each |
| A letter from the clock, every 15 s | -60 each |
| Wrong guess | -20 |
| Floor while playing | 50 |

Letters stop at half the name, from the clock and hints together. Rounds
expire after an hour. Guesses ignore case, spaces, hyphens and accents, so
`toapayoh` is Toa Payoh.

## Auth and limits

Bots send `Authorization: Bearer <BOT_API_TOKEN>`. A wrong token is a `401`,
not a fallback to browser rules. Browsers send nothing and are rate limited by
IP through `mrtguessr_hit`; bots are not, since every Telegram player shares
the VPS's address. Submissions are 5 per 10 minutes per IP.

## Files

| Path | What it is |
|---|---|
| `round/*.js`, `leaderboard/*.js` | The endpoints. |
| `_lib/game.js` | Rules, the mask, the clock, the round view, optimistic updates. |
| `_lib/http.js` | Auth, rate limits, input checks, error replies. |
| `_lib/names.js` | Leaderboard name cleaning and the English and Chinese word filter. |
| `_lib/lines.js` | Line codes, names and colours. |
| `_lib/supabase.js` | Supabase REST with the service role key. |

Vercel does not route files under `_lib/`.
