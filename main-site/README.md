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

**Offline:** the page, its scripts, the station and line data, Leaflet and the
Jua font are precached, so the site loads with no connection. Rounds need the
network: nothing under `/api/` is ever cached.

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
