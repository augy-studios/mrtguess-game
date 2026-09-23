# discord-bot

The Discord client for MRT Station Guesser. discord.py with slash commands,
installable on a server or on a user account, and usable in servers, the
bot's direct messages, and other DMs and group DMs. First-time Developer
Portal setup is in [`setup.md`](setup.md).

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
variable listed, or that Discord refused the token.

## How it plays

The same game as the Telegram bot, with the same settings. Where Discord
differs:

- A round belongs to one player in one channel. A server channel can hold
  several players' rounds at once, each on its own card, and a card's
  buttons answer only the player it belongs to.
- `/play` sends a round card: the masked name, the letter count, the score,
  the line colour, and buttons to guess, buy the next hint, and give up.
- The card edits itself as the clock reveals a letter every 15 seconds.
  Where the bot is not in the channel (a user install), it edits through the
  token of the command that sent the card, which lasts 15 minutes. After
  that the card stops updating until `/hint` or `/guess` sends a fresh one.
- Guesses come three ways. The card's **Guess** button opens a box, and a
  wrong guess there edits the card in place. `/guess station` sends a fresh
  card to the bottom and removes the old one (or, with old card removal off,
  leaves it without buttons). In a direct message, any plain message is a
  guess too, as on Telegram. In a server, plain messages are ignored.
- Hints from the card's button edit it in place; `/hint` sends a fresh card.
  The map hint is a picture inside the card.
- A solved round offers `Add as NAME` in one tap, and "Another name", which
  opens a box for one. NAME is the saved leaderboard name or, until one is
  saved, the player's Discord display name, with emoji and symbols dropped and
  cut to 20 characters. A typed name is remembered in its place; the Discord
  name is never saved, so it follows the account.
- `/help` is shown to everyone in the channel, and its Play and Leaderboard
  buttons work for whoever presses them. `/settings` answers only the player
  who asked. `/help` is the help; there is no `/start`.
- `/settings` holds the same name and four switches as the Telegram bot,
  each redrawn in place when pressed:

| Setting | Default | What it does |
|---|---|---|
| Leaderboard name | Discord display name | Filled in by every successful submit under a typed name; can be changed (checked by the API) or cleared back to the Discord name. |
| Add solved rounds automatically | off | Submits every solve under the leaderboard name. Needs a usable name, saved or from Discord. |
| Ask before buying a hint | off | A yes/no, seen only by the player, with the cost before any hint spends points. |
| Remove old round cards | on | Off leaves old cards in the channel without their buttons, instead of deleting them. |
| Map hint colours | light | Dark draws the map on the site's dark background. |

Settings are the bot's own, kept against the Discord user id. They are not
shared with the Telegram bot or the PWA; the leaderboard is.

## What lives where

| | |
|---|---|
| Game state, scores, answers | The API, in Supabase. The bot has no Supabase key. |
| Buttons, the live card per player per channel (with the token that can edit it), settings | `bot.sqlite3`, local and gitignored. |

Buttons carry an opaque id looked up in SQLite, matched by pattern, so they
keep working across restarts and cannot be forged. Losing `bot.sqlite3` costs
old buttons, the live cards' updates and everyone's settings, never a score.

## Files

| File | What it does |
|---|---|
| `bot.py` | Entry point: config, lock, the client, slash commands, the clock task. |
| `handlers.py` | Commands, buttons, guesses, the name and guess boxes, and the reveal scheduler. |
| `views.py` | Message builders, as embed plus buttons. |
| `buttons.py` | The one button class every button uses, and the registry lookup. |
| `commands.py` | The command list. `python commands.py` prints it. |
| `api.py` | The game API client. |
| `mapimage.py` | Draws the map hint with Pillow. A copy of `telegram-bot/mapimage.py`. |
| `db.py` | SQLite. |
| `config.py` | Environment variables. |
| `lock.py` | One instance at a time. The same as the Telegram bot's. |

## Checking it by hand

1. `/help`: how to play, a scoring table, the leaderboard rules, the command
   list and what is stored. In a server everyone sees it, and anyone can
   press Play. "Play in the browser" opens the site.
2. `/play`: a card with the masked name. Wait 15 seconds: a letter appears in
   place and the score drops by 60.
3. Press Guess and send a wrong answer: the same card says so. Send
   `/guess` with a wrong answer: a new card at the bottom, the old one gone.
4. Press the hint button three times: code, then map (the picture appears
   inside the card), then the Chinese name.
5. Guess right: the answer card, with `Add as NAME` (your Discord name),
   Another name and Play again.
6. Another name, send a rude name (refused, only you see why), then a good one.
7. `/settings`: turn on automatic adding and solve one more; the result card
   says it was added. Turn on hint checks: a hint now asks first, and only you
   see the question. Turn off old card removal: `/guess` leaves the old card
   without buttons. Switch the map to dark and buy a map hint.
8. Have a second account `/play` in the same channel: two cards, and neither
   player can press the other's buttons.
9. Direct message the bot: `/play`, then type a guess as a plain message.
10. `/leaderboard`: a table, and the button swaps to total points in place.
11. Install the app to your account and, in a DM with a friend (or a server
    without the bot), type `/`: the commands are listed. `/play` there, and
    the card still reveals letters and takes hints from its buttons.
12. Restart the bot and press an old button: it still works.
13. Start a second copy: refused with the first one's pid.
