# scripts

Run from the repo root. The Node scripts need Node 18 or later and no
dependencies; the seed needs Python 3.10 or later and no dependencies.

| Script | What it does |
|---|---|
| `seed_supabase.py` | Loads `main-site/data/stations.geojson` into `mrtguessr_stations`. Upserts on the English name, so it is safe to run again. `--dry-run` prints what it would send. |
| `vendor-sgraildata.mjs <clone>` | Rebuilds `main-site/data/` from a local sgraildata clone. |
| `check-sw.mjs` | Fails if `skipWaiting()` or `clients.claim()` appear outside the service worker's message handler, or other update bar rules break. |
| `check-precache.mjs` | Fails if a `PRECACHE` entry is missing on disk, or a module or data file is not precached. |
| `check-theme.mjs` | Fails if a page's pre-paint script drifts from the hours or key in `js/theme.js`. |

The seed reads `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from the environment,
or from a `.env` in `scripts/` or the repo root (both gitignored):

```
python scripts/seed_supabase.py --dry-run
python scripts/seed_supabase.py
```

Run it after `migrations/001_mrtguessr_schema.sql`, and again whenever
`main-site/data/` is refreshed.
