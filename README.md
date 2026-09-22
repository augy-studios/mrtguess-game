# MRT Station Guesser

Guess the Singapore MRT or LRT station from its masked name. A letter shows
every 15 seconds, Skribbl style, and every letter and hint costs points.

Live at <https://mrtguessr.uwuapps.org>. Three clients over one API: a PWA, a
Telegram bot and a Discord bot.

## What runs where

| Part | Runs on |
|---|---|
| `main-site/`, the PWA and the game API (`main-site/api/`) | Vercel, root directory `main-site` |
| Database, `mrtguessr_*` tables | The shared uwuapps Supabase project |
| `telegram-bot/` | The Debian 13 VPS, one process |
| `discord-bot/` (not built yet) | The Debian 13 VPS, one process |

**On the VPS: the two bots, one process each, and nothing else.** No cron, no
database, no web server. The Telegram bot draws its map hint with Pillow in
its own process. The bots never hold a Supabase key; they call the API.

## Layout

```
README.md
migrations/      SQL to run in the Supabase SQL editor
scripts/         seed script and pre-deploy checks
main-site/       the site Vercel deploys, including api/
telegram-bot/    Telethon bot
discord-bot/     discord.py bot, build step 5
```

The `uwuapps-*.md`, `update-bar-spec.md`, `telethon-richmessage-retrofit.md`
and `01-station-guess.md` files at the root are the specs this is built to.

## First setup

1. Run every file in `migrations/`, in order, in the Supabase SQL editor.
2. Seed the stations: `python scripts/seed_supabase.py` with `SUPABASE_URL`
   and `SUPABASE_SERVICE_KEY` set (see `scripts/README.md`).
3. On the Vercel project, add `BOT_API_TOKEN`: a long random string, for
   example from `openssl rand -hex 32`. `SUPABASE_URL` and
   `SUPABASE_SERVICE_KEY` are already there.
4. Deploy `main-site`.
5. Set up the Telegram bot: `telegram-bot/setup.md`.

## Before every deploy

1. Bump `VERSION` in `main-site/sw.js`. Without it, returning visitors keep
   the previous build and never see the update bar.
2. Run the checks:

```
node scripts/check-sw.mjs
node scripts/check-precache.mjs
node scripts/check-theme.mjs
```

## Build status

Following the build order in `01-station-guess.md`:

- [x] 0. Theme and the head template (`main-site/index.html`)
- [x] 1. Schema (`migrations/`) and seed (`scripts/seed_supabase.py`)
- [x] 2. The API
- [x] 3. Telegram bot
- [ ] Check the mechanic is fun on Telegram before going further
- [ ] 4. PWA game screen (the site is a themed, offline-capable shell until then)
- [ ] 5. Discord bot

All five hint tiers are in the API already, since the letter reveal is the
core mechanic and the step 3 check needs it.
