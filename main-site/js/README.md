# js

ES modules, loaded from `app.js`. Every file here must also be listed in
`PRECACHE` in `sw.js`; `scripts/check-precache.mjs` fails if one is missing.

| File | What it does |
|---|---|
| `app.js` | Boot and theme modal wiring. |
| `rules.js` | The game's rules, shared with the API (`api/_lib/game.js` imports it): hints, the letter clock, difficulty, time limits, scoring, and a turn worked out from its events. Pure. |
| `game.js` | The solo screen: the live round, the clock and time limit, hints, guesses, the result and its replay link. |
| `round-view.js` | The masked name, hint rows and score breakdown, drawn the same way by solo, party and replay. |
| `party.js` | Party games: hosting, joining, the lobby and every screen of a game, drawn from the host's snapshots. |
| `party-host.js` | The party game itself, run on the hosting device: stations, clock, judging, snapshots. |
| `p2p.js` | Pairing over PeerJS, STUN only, from `STUN-p2p-spec.md`. Loads PeerJS on first use. |
| `qr.js` | QR codes for the join link, from uwuPromptr. |
| `stations.js` | The station list from `data/stations.geojson`, for the party host and replays. |
| `replay.js` | Replay links (short through the API, long in the link otherwise) and the replay player. |
| `replay-format.js` | The replay format and the long-link packing, shared with the API. |
| `api.js` | Calls to `/api/`, and this browser's random `client_key`. |
| `map.js` | The map hint, drawn with Leaflet, which loads on the first map hint. One map per element. |
| `leaderboard.js` | The leaderboard window, both boards. |
| `settings.js` | The settings window and the settings themselves, kept in local storage. |
| `theme.js` | Theme system with time-based mode, from `uwuapps-theme.md`. |
| `icons.js` | Inline SVG icons. |
| `ui.js` | Icon hydration, modals, HTML escaping, and which card shows (solo, party or replay). |
| `update-bar.js` | Service worker registration and the update bar. |
