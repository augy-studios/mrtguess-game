# js

ES modules, loaded from `app.js`. Every file here must also be listed in
`PRECACHE` in `sw.js`; `scripts/check-precache.mjs` fails if one is missing.

| File | What it does |
|---|---|
| `app.js` | Boot and theme modal wiring. |
| `theme.js` | Theme system with time-based mode, from `uwuapps-theme.md`. |
| `icons.js` | Inline SVG icons. |
| `ui.js` | Icon hydration, modals, HTML escaping. |
| `update-bar.js` | Service worker registration and the update bar. |
