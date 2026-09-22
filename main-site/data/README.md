# data

A snapshot of [cheeaun/sgraildata](https://github.com/cheeaun/sgraildata),
`data/v1/sg-rail.geojson`, at commit `d64f9408` (12 July 2026), the same one
MRT Map Explorer ships. Built by `scripts/vendor-sgraildata.mjs`; do not edit
by hand. Never fetched at runtime.

- `stations.geojson`: 184 stations. Properties `name`, `name_zh`
  (Simplified Chinese), `name_ta` and `codes`. An interchange is one feature
  with several codes. `scripts/seed_supabase.py` loads it into
  `mrtguessr_stations`.
- `lines.geojson`: 11 line features with a `line` code. Drawn as the blank
  map for the tier 3 hint, by Leaflet in the PWA and by the Telegram bot.

Exits and buildings are left out: incomplete upstream and not needed.
Upstream ids are not unique, so nothing is keyed on them.

To refresh:

```
git clone --depth 1 https://github.com/cheeaun/sgraildata.git <somewhere>
node scripts/vendor-sgraildata.mjs <somewhere>/sgraildata
python scripts/seed_supabase.py
```

Then update the commit and date above and bump `VERSION` in `sw.js`.
