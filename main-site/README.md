# main-site

What Vercel deploys, served at <https://mrtguessr.uwuapps.org>. No build
step: these files are served as they are, and `api/` holds the serverless
functions.

| Path | What it is |
|---|---|
| `index.html` | The game page. Its `<head>` is the template every other page copies. |
| `404.html`, `404.css` | Not-found page. |
| `sw.js` | Service worker: offline shell, and the update bar's waiting worker. |
| `manifest.json` | PWA manifest. |
| `api/` | The game API, the only place game rules exist. See `api/README.md`. |
| `css/` | Theme system and app styles. |
| `js/` | ES modules. `app.js` is the entry point. |
| `data/` | Vendored sgraildata snapshot. |
| `vendor/` | Vendored Leaflet, for the map hint. |
| `images/` | Manifest screenshots. |

**The game screen:** the page opens on a round, the masked name and a text
box, with nothing to read first. Letters the server's clock reveals appear in
place, with a bar counting down to the next. Hints are bought in order from
one button; give up takes two taps. A solved round can be added to the
leaderboard under a name, which is remembered in this browser. A round left
open survives a reload, keyed by a random `client_key` in local storage. The
trophy button opens both leaderboards.

**Settings:** the gear button holds the Telegram bot's `/settings`, kept in
this browser's local storage and separate from the bot's:

| Setting | Default | What it does |
|---|---|---|
| Leaderboard name | not set | Checked by `/api/leaderboard/name`; also saved by every successful submit. |
| Add solved rounds automatically | off | Submits every solve under the saved name. Needs a name; clearing it turns this off. |
| Ask before buying a hint | off | The hint button takes a second tap, naming the cost. |
| Map hint colours | match page | Light or dark map whatever the page's mode. |
| Difficulty | normal | Easy, normal or hard, from the next round. Scales the points; see `api/README.md`. |
| Time limit | none | None, 2 minutes, 1 minute or 30 seconds. A limit scales the points and adds a speed bonus; running out ends the round with no points. |

The bot's "remove old round cards" is left out: there are no old cards here.
The bots always play normal with no time limit.

**Party games:** the people button in the header. One device hosts and shows
a code, a QR code and a link (`/join?id=CODE`); up to seven more join with
any of them, for eight players including the host. Before the game the host
picks the stations per game (5, 10, 20, or any number up to all 184), the
difficulty and the time per station (30 seconds, 1 or 2 minutes), and the
guests see the choices as they change. Every player gets the same station at
the same time, with the same letters showing in the same order, and buys
their own hints. A station ends when everybody still connected has solved it
or given up, or at the time limit. Points per station use the same
multipliers as solo; the game score at the end is the total times a length
multiplier (× 1 for 5 stations, × 1.25 for 10, × 1.5 for 20, a quarter more
per doubling, a little under 1 below 5).

The host's device runs the game (`js/party-host.js`) with the rules in
`js/rules.js`, and the devices talk directly over WebRTC, set up through
PeerJS's public broker with STUN only, as `STUN-p2p-spec.md` at the repo root
describes. So they have to be on the same network, or one on a hotspot from
the other; guest wifi that isolates clients will not work. The host has the
answers in memory, so party scores never go on the leaderboard. A guest that
reloads or drops rejoins its seat by itself; a host that reloads carries on
with the same game and code, from session storage.

**Replays:** Share replay on a solo result, and Share replay or Watch replay
at the end of a party game. Online the link is short, `/r/<id>`, stored by
`/api/replay/create`; a party game that cannot reach the API gets a long link
with the whole game in it (`/?replay=...`, deflated JSON), the way chess-game
shares replays. A replay plays each station back with every player's letters,
hints and guesses, at 1x to 8x, and works every score out again from the
events. Solo replays are checked by the server; party ones say they are not.

**Offline:** the page, its scripts, the station and line data, Leaflet and the
Jua font are precached, so the site loads with no connection. Rounds need the
network: nothing under `/api/` is ever cached. A party game needs it only to
pair, and PeerJS is loaded from cdnjs when somebody hosts or joins, never
cached by the service worker. `/join` and `/r/<id>` are rewrites to the game
page, in `vercel.json` and in the worker.

**Privacy:** in a party game each device learns the others' public IP
addresses, as any peer-to-peer connection does, and PeerJS's broker sees peer
ids and IP addresses, never the game. The privacy policy should say so.

**Updates:** a new service worker installs and waits. The update bar at the
top of the page offers Reload or Not now, and nothing reloads until the reader
asks. See `update-bar-spec.md` at the repo root.

Bump `VERSION` in `sw.js` on every change to anything in this directory.

## Environment variables (Vercel)

Documented in `.env.example`. `.vercelignore` keeps every env file out of
deployments, since anything in this directory would otherwise be served.

| Variable | Used for |
|---|---|
| `SUPABASE_URL` | The shared uwuapps project. Already set. |
| `SUPABASE_SERVICE_KEY` | Service role key. Server side only, never sent to a browser. Already set. |
| `BOT_API_TOKEN` | The bots' bearer token. New for this app. |

`LTA_ACCOUNT_KEY` exists on the project and is not used here.
