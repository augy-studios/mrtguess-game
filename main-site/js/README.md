# js

ES modules, loaded from `app.js`. Every file here must also be listed in
`PRECACHE` in `sw.js`; `scripts/check-precache.mjs` fails if one is missing.

| File | What it does |
|---|---|
| `app.js` | Boot and theme modal wiring. |
| `game.js` | The game screen: the live round, the clock, hints, guesses and the result. |
| `api.js` | Calls to `/api/`, and this browser's random `client_key`. |
| `map.js` | The map hint, drawn with Leaflet, which loads on the first map hint. |
| `leaderboard.js` | The leaderboard window, both boards. |
| `settings.js` | The settings window and the settings themselves, kept in local storage. |
| `theme.js` | Theme system with time-based mode, from `uwuapps-theme.md`. |
| `icons.js` | Inline SVG icons. |
| `ui.js` | Icon hydration, modals, HTML escaping. |
| `update-bar.js` | Service worker registration and the update bar. |
