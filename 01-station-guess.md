# Claude Code Prompt — Station Guess

## Read first, before writing any code

Do these two things before creating a single file. Do not scaffold, do not write
markup, do not write CSS until both are done.

**1. Read `uwuapps-theme.md`.** It defines the theme for this project: the
two-axis theming architecture (colour theme plus light and dark mode), the WCAG
AA contrast requirements, and the time-based mode switching with
boundary-crossing timers. Apply it throughout. Do not invent a visual style, and
do not approximate the theme from memory.

If `uwuapps-theme.md` is not in this repo, look in the sibling uwuapps project
directories. If it cannot be found, stop and ask. Do not proceed with a guess.

**2. Author the repo root `index.html` first, and treat its `<head>` block as the
template for every other HTML file in this repo.** Every subsequent page copies
that head structure exactly, changing only the title, description, and
page-specific tags. Do not write a fresh head block per page, and do not
restructure the head once it is set.

Both steps gate everything else. The full theming detail is in the "Theming and
HTML structure" section below.

## What to build

A Singapore MRT station-guessing game. The player is shown a masked station
name plus a hint, and types their guess. Letters reveal progressively over
time, Skribbl-style. Score decays as hints are consumed.

Ships as three clients over one shared API: a PWA, a Telegram bot, and a
Discord bot.

**Design rule: there must be nothing to learn before playing.** The player
sees a masked word and a text box. No tutorial, no rules screen, no mode
select on first load.

## Core mechanic

```
_ _ _ _ _ _ _        7 letters, Circle Line
_ _ _ _ _ _ e        +1 letter after 15s
_ a _ _ _ _ e        +1 letter after 30s
```

Hint ladder, each tier costing score. All tiers are derived from the dataset,
none are hand-authored:

1. Line colour only
2. Station code prefix (NS, EW, CC, DT, TE, NE)
3. Position marked on a blank map, no labels
4. Chinese name shown (大巴窑 → Toa Payoh)
5. Progressive letter reveal

## Critical security requirement

**The answer must never be sent to the client.** Masking in client-side
JavaScript is trivially defeated by reading the network response. The round
answer lives server-side in Supabase keyed by `round_id`. The client receives
only the current mask, the hint tier, and its score.

All guess validation happens in the Vercel serverless functions. Treat the
PWA as fully untrusted.

## Data

Source: `https://github.com/cheeaun/sgraildata` — the `/data` folder.

Roughly 170 MRT and LRT stations with station codes, English names, Chinese
names, Tamil names, and coordinates.

Vendor a snapshot into the repo. Do not fetch it at runtime. Write a seed
script that loads it into Supabase once.

Known data caveats to handle defensively: ids are not guaranteed unique, and
some exit data is incomplete. You only need codes, names and coordinates, so
skip the building and exit data entirely.

Interchange stations appear under multiple codes. Deduplicate by English name
so Dhoby Ghaut is one answer, not three.

## Supabase schema

All tables prefixed `stationguess_`.

These tables live in the existing shared uwuapps Supabase project, alongside the
tables for every other uwuapps app. Do not create a new Supabase project.

Before writing the seed script, check whether that project already holds MRT
station data from an earlier app (SG MRT Alerts, MRT Info PWA, or similar). If a
usable stations table exists, read from it instead of creating a second copy. If
it exists but lacks Chinese or Tamil names, write the seed as an enrichment pass
on that table rather than a fresh load. Stop and ask if this is ambiguous.

```sql
create table stationguess_stations (
  id bigserial primary key,
  name_en text not null unique,
  name_zh text,
  name_ta text,
  codes text[] not null,          -- ['NS24','NE6','CC1']
  lines text[] not null,
  lat double precision,
  lon double precision
);

create table stationguess_rounds (
  id uuid primary key default gen_random_uuid(),
  station_id bigint references stationguess_stations(id),
  client_key text,
  hint_tier smallint not null default 0,
  revealed_positions smallint[] not null default '{}',
  score int not null default 1000,
  solved boolean not null default false,
  submitted boolean not null default false,
  created_at timestamptz not null default now()
);

create table stationguess_leaderboard (
  id bigserial primary key,
  name text not null,
  score int not null,
  round_id uuid not null unique references stationguess_rounds(id),
  created_at timestamptz not null default now()
);

create index stationguess_lb_best
  on stationguess_leaderboard (lower(name), score desc);
```

One solved round is one game, so a round is the unit submitted to the
leaderboard.

## No accounts

There is no login anywhere in this app. Do not create a users table, do not use
`uwu_users` or `uwu_sessions`, and do not use Supabase Auth.

`client_key` is an opaque random id the client generates once and keeps in local
storage. It exists only so a request can be tied back to its own in-progress
game. It is not an identity, it grants nothing, and it is never displayed. Bots
put their platform user id in the same field.

Because there are no accounts, there is no currency, no cosmetics, and no
cross-session progression. Do not build them.

## Leaderboard

Public and readable by anyone, with no login to view it.

When a player finishes a game they may optionally submit a display name. A name
can be submitted any number of times across different games, but the public
board shows only that name's highest score.

```sql
select distinct on (lower(name)) name, score, created_at
from stationguess_leaderboard
order by lower(name), score desc, created_at asc;
```

The `created_at asc` tiebreak means the earliest of an equal top score wins.

Names are grouped case-insensitively, so `Augy` and `augy` are one entry.
Display the casing attached to the best score.

Two different people can pick the same name and will share an entry. That is
unavoidable without accounts and is not a bug. Put a one-line note near the
submit field so nobody is surprised when their entry seems to change.

**Score is never accepted from the client.** The submit endpoint takes a game id
and a name, and reads the score the server already computed for that game.
Reject the submission if the game is unfinished, already submitted, or older
than one hour. The unique constraint on the game id enforces one submission per
completed game.

Name validation, all server-side:

- Trim, collapse internal whitespace, cap at 20 characters
- Allow letters (including CJK), digits, spaces, hyphens and underscores
- Profanity filter covering English and Chinese
- Reject empty names after trimming

Rate limit submissions by IP, since there is no account to limit against.


## API

Vercel serverless functions. This is the only place game rules exist. All
three clients call these endpoints.

```
POST /api/round/new           → { round_id, mask, length, hint_tier, line_color }
POST /api/round/guess         → { correct, mask, score, solved }
POST /api/round/hint          → { mask, hint_tier, score, penalty }
POST /api/leaderboard/submit  → { round_id, name } → { rank, best_score }
GET  /api/leaderboard         → { entries: [{ name, score }] }
```

`GET /api/leaderboard` is public and unauthenticated. Cache it briefly.

Guess matching should be forgiving: case-insensitive, whitespace-normalised,
and tolerant of missing spaces ("toapayoh" matches "Toa Payoh").

Bots authenticate with a shared bearer token from an environment variable.
The PWA calls the endpoints without one and is rate-limited by IP.

## Environment variables

These already exist on the Vercel project. Use these exact names. Do not invent
new ones for Supabase or LTA, and do not rename them.

```
SUPABASE_URL
SUPABASE_SERVICE_KEY
LTA_ACCOUNT_KEY
```

`SUPABASE_SERVICE_KEY` is the service role key and bypasses row level security.
It is server-side only. It may appear in Vercel serverless functions and in the
seed script, and nowhere else. Never send it to the browser, never inline it into
client JavaScript, and never give it a client-exposed prefix.

`LTA_ACCOUNT_KEY` is not needed by this app. Do not add features that use it.

The one new variable this repo introduces:

```
BOT_API_TOKEN
```

A shared secret the bots send as `Authorization: Bearer <token>` when calling the
API. Set it on Vercel and in each bot's own env. The bots never talk to Supabase
directly and never hold a Supabase key. All bot state goes through the API.

## Repo layout

```
station-guess/
├── README.md
├── .gitignore
├── main-site/
│   ├── README.md
│   ├── index.html
│   ├── api/
│   │   └── README.md
│   └── data/            # vendored sgraildata snapshot
├── telegram-bot/
│   ├── README.md
│   ├── setup.md
│   └── .gitignore
├── discord-bot/
│   ├── README.md
│   └── .gitignore
└── scripts/
    └── seed_supabase.py
```

Vercel's root directory is set to `main-site`, which is why `api` sits inside
it. Every directory including the project root gets a README.

## Bot conventions

**Telegram** — Telethon. Has a `start` command that lists all commands and
gives bot info. No `help` command. Include a `setup.md` covering BotFather
setup: about text, description, and command list.

**Discord** — discord.py with slash commands. Has a `help` command that lists
all commands and gives bot info. No `start` command.

Both use SQLite locally for scheduling and for persisting interaction buttons
across restarts. All game state goes through the API to Supabase, not into
local SQLite.

Never mention the bot's name inside command text.

## Theming and HTML structure

Read `uwuapps-theme.md` before writing any markup or CSS, and apply that theme
throughout. If it is not in this repo, look in the sibling uwuapps project
directories. Stop and ask rather than guessing at the theme if it cannot be
found.

Author the repo root `index.html` first. Its `<head>` block is the canonical
template for this repo: every other HTML file copies that head structure
exactly, changing only the title, description, and page-specific tags. Do not
write a fresh head block per page.

Theme switching follows the uwuFlights pattern: `data-color-theme` and
`data-mode` on the `html` element, seven brand swatches plus light and dark.
Light mode is the default and ignores OS preference. The default brand colour is
`#ccffcc` mint green.

Text and body contrast must meet WCAG AA.

### Visual style

Professional-looking glassmorphism. Glass cards over a flat background.

Backgrounds use static colours derived from the active theme. No gradients, no
orbs, no blobs, no animated background effects of any kind. If the background
needs visual interest, the answer is a different flat colour, not a gradient.

Jua is the font throughout, with no secondary typeface.

No emoji anywhere in the UI. Every icon is an inline SVG, including the ones a
first draft would reach for emoji to fill.

### File splitting

No single-file HTML. Markup, styles, and behaviour go in separate files:

```
index.html
css/style.css
js/app.js
```

Split further by concern as the app grows. Inline `<style>` and `<script>`
blocks are not acceptable except for the theme-flash-prevention snippet in the
head, if the theme doc calls for one.

### Buy Augy a Coffee button

Place it immediately next to the theme switcher button, styled to match it.

- A coffee icon as an inline SVG, no emoji
- Opens `https://donate.stripe.com/28o2akeAr3hv0DK6oo` in a new tab
- `rel="noopener noreferrer"`
- Accessible label, since the button is icon-only

### Delivery

Give every project file separately. Do not produce a zip or any other archive.
Deployment is handled manually.

### Hosting

The site and its serverless functions run on Vercel. The database is the shared
uwuapps Supabase project.

State explicitly in the root README what needs to run on the Debian 13 VPS. For
this repo that is the two bots, one process each, and nothing else. Flag it
clearly if any part of the design would require something more on the VPS, rather
than assuming it is fine to add.

## PWA

Installable, works offline for the map and station data, requires network for
rounds. Use the existing template's `<head>` block as the guideline for meta
tags and manifest wiring.

## Code style

Keep comments short. No decorative comment banners or long separator lines.

Deliver files individually. Do not produce a zip.

## Build order

0. Read `uwuapps-theme.md` and author the root `index.html` head block
1. `seed_supabase.py` and the schema
2. The four endpoints
3. Telegram bot as the first client
4. PWA
5. Discord bot, then hint tiers 4 and 5

Stop after step 3 and confirm the mechanic is fun before building the PWA.
