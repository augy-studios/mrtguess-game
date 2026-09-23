# setup.md

Discord Developer Portal setup for the Discord bot, and the `.env` it runs
from. Everything is at <https://discord.com/developers/applications>.

## 1. Create the application

**New Application**, and name it. The name is what players see on the bot
and on its slash commands.

## 2. General Information

**Description**, up to 400 characters, shown on the bot's profile:

```text
A Singapore MRT and LRT guessing game. You see a station with its letters hidden and the colour of its line. A letter shows every 15 seconds, and hints give the station code, a map, and the Chinese name, each for a few points. Guess in as few as you can, then put your score on the public leaderboard. No sign up. Send /help for the rules.
```

Upload the app icon from `main-site/SNG-512.png`.

## 3. Bot

| Setting | Value | Why |
|---|---|---|
| **Reset Token** | copy it | This is `DISCORD_BOT_TOKEN`. If it ever leaks, reset it again at once. |
| Public Bot | On, or off to keep invites to yourself | Off means only you can add it to a server. |
| Requires OAuth2 Code Grant | Off | Not used. |
| Presence Intent | Off | Not used. |
| Server Members Intent | Off | Not used. |
| Message Content Intent | Off | Not needed. Guesses in a server come through `/guess` and the card's Guess button; direct message text reaches a bot without this intent. |

## 4. Installation

| Setting | Value |
|---|---|
| Installation Contexts | **Guild Install** and **User Install** both ticked. |
| Install Link | Discord Provided Link |
| Guild Install scopes | `applications.commands`, `bot` |
| Guild Install permissions | View Channels, Send Messages, Send Messages in Threads, Embed Links, Attach Files |
| User Install scopes | `applications.commands` |

The install link asks whether to add the bot to a server or to your account.

- **Server**: the commands work in that server's channels, for everyone.
- **Account**: the commands follow you into any server, DM or group DM,
  including ones the bot is not in. There the bot sends and edits cards
  through each command's own token, which Discord honours for 15 minutes, so
  a card that is older than that stops revealing letters. Use `/hint` or
  `/guess` to get a fresh card. A server can turn off external apps, and one
  with more than 25 members shows their answers only to you.

The bot's own DM works with either install. Plain messages are guesses only
there.

## 5. Commands

Nothing to paste. The bot registers its slash commands from `commands.py`
and syncs them with Discord at every startup; the log says `synced 7 slash
commands`. `python commands.py` prints the list:

```text
/help - How to play, scoring, the leaderboard, and every command.
/play - Start a new round.
/guess - Guess the station in the round you are playing.
/hint - Buy the next hint for the round you are playing.
/giveup - End the round and see the answer.
/leaderboard - Best scores and total points, one row per name.
/settings - Your leaderboard name, hint checks, card tidying and map colours.
```

A new or changed command can take a minute to show in the client. Restarting
Discord makes it show at once. The sync also sends where each command may be
used; commands synced before user installs were allowed stay off user installs
until the bot restarts and syncs again.

## 6. `.env`

```bash
cp .env.example .env
```

| Variable | From |
|---|---|
| `DISCORD_BOT_TOKEN` | Step 3 |
| `BOT_API_TOKEN` | The same value as on the Vercel project |
| `DONATION_URL` | Optional. The coffee button on `/help`; empty hides it |

`SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are not needed: the bot only talks
to the game API.

## 7. Start it

```bash
pip install -r requirements.txt
python bot.py
```

The log should show `synced 7 slash commands` and `connected as <name>`.
Then send `/help`, and walk the checklist in [`README.md`](README.md).
