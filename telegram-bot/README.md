# telegram-bot

The Telegram client for MRT Station Guesser. Telethon, private chats only.
First-time BotFather setup is in [`setup.md`](setup.md).

## Running it

On the VPS, in your own tmux session, from this directory:

```bash
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # then fill it in
python bot.py
```

It needs the rest of the repo beside it: the map hint reads
`../main-site/data/lines.geojson`.

A second copy is refused while one is running (exit status 3, naming the pid).
Exit status 2 means the environment is incomplete, with every missing
variable listed.

## How it plays

- `/play` sends a round card: the masked name, the letter count, the score,
  the line colour, and buttons for the next hint and for giving up.
- The card edits itself as the clock reveals a letter every 15 seconds.
- Any message that is not a command is a guess. A wrong guess brings a fresh
  card to the bottom of the chat and deletes the old one (or, with old card
  removal off, leaves it without buttons).
- The map hint is a picture inside the round card, not a separate message:
  the network, no labels, a ring on the station. It is uploaded once per round
  and attached to the card's rich message with a `tg://photo?id=map` link, so
  the clock's edits and fresh cards after a guess keep it.
- A solved round offers `Add as NAME` in one tap, and "Another name", which
  asks for a name in the next message. NAME is the saved leaderboard name or,
  until one is saved, the player's Telegram first name, with emoji and
  symbols dropped and cut to 20 characters. A typed name is remembered in
  its place; the Telegram name is never saved, so it follows the account.
  With no usable name at all, the card offers "Add to leaderboard" instead.
- `/settings` holds the leaderboard name and four switches, each redrawn in
  place when pressed:

| Setting | Default | What it does |
|---|---|---|
| Leaderboard name | Telegram first name | Filled in by every successful submit under a typed name; can be changed (checked by the API) or cleared back to the Telegram name. |
| Add solved rounds automatically | off | Submits every solve under the leaderboard name. Needs a usable name, saved or from Telegram. |
| Ask before buying a hint | off | A yes/no message with the cost before any hint spends points. |
| Remove old round cards | on | Off leaves old cards in the chat without their buttons, instead of deleting them. |
| Map hint colours | light | Dark draws the map on the site's dark background. |

## What lives where

| | |
|---|---|
| Game state, scores, answers | The API, in Supabase. The bot has no Supabase key. |
| Buttons, the live card per chat, name prompts, settings | `bot.sqlite3`, local and gitignored. |

Buttons carry an opaque id looked up in SQLite, so they keep working across
restarts and cannot be forged. Losing `bot.sqlite3` costs old buttons, the
live card's updates and everyone's settings, never a score. Back it up with
the rest of the VPS if the settings matter.

## Files

| File | What it does |
|---|---|
| `bot.py` | Entry point: config, lock, Telethon, routing, the clock task. |
| `handlers.py` | Commands, buttons, guesses and the reveal scheduler. |
| `views.py` | Message builders, as rich message plus buttons. |
| `reply.py` | Telegram Rich Messages, per `telethon-richmessage-retrofit.md`. |
| `commands.py` | The command list. `python commands.py` prints it for BotFather. |
| `api.py` | The game API client. |
| `mapimage.py` | Draws the map hint with Pillow. |
| `db.py` | SQLite. |
| `config.py` | Environment variables. |
| `lock.py` | One instance at a time. |

## Rich messages

Structured replies (`/start`, round cards, results, the leaderboard) go out as
native Telegram Rich Messages with a plain text fallback, through raw
`SendMessageRequest` and `EditMessageRequest` in `reply.py`. One-line notices
("Send /play to start a round.", the name prompt, errors) stay plain. A
refused rich send falls back to the plain text and logs
`rich send failed, falling back`; on a current client that line should never
appear. There is no inline mode, so no inline results.

## Checking it by hand

1. `/start`: how to play, a scoring table, the leaderboard rules, the command
   table and what is stored, rendered natively. It is the help; there is no
   `/help`, and typing it points back to `/start`.
2. `/play`: a card with a code block mask. Wait 15 seconds: a letter appears
   in place and the score drops by 60.
3. Send a wrong guess: a new card at the bottom saying so, the old one gone.
4. Press the hint button three times: code, then map (the card redraws in
   place with the picture inside it, and no new message arrives), then the
   Chinese name. Wait for a letter: the map stays on the card.
5. Guess right: the answer card, with `Add as FIRSTNAME` (your Telegram
   first name), Another name and Play again. `/settings` shows the name as
   "(your Telegram name)".
6. Another name, send a rude name (refused, asks again), then a good one.
7. Solve another: the card offers `Add as NAME`, with the typed name. Press
   it. In `/settings`, Use Telegram name goes back to the first name.
8. `/settings`: turn on automatic adding and solve one more; the result card
   says it was added. Turn on hint checks: a hint now asks first. Turn off
   old card removal: a wrong guess leaves the old card, without buttons.
   Switch the map to dark and buy a map hint.
9. `/leaderboard`: a table.
10. Restart the bot and press an old button: it still works.
11. Start a second copy: refused with the first one's pid.
