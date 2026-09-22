"""Loads the vendored station snapshot into mrtguessr_stations.

Run from the repo root, after migrations/001_mrtguessr_schema.sql:

    SUPABASE_URL=... SUPABASE_SERVICE_KEY=... python scripts/seed_supabase.py
    python scripts/seed_supabase.py --dry-run
    python scripts/seed_supabase.py --sql

--sql writes the same rows as migrations/002_mrtguessr_seed_stations.sql,
for pasting into the SQL editor instead of running this against the API.

Standard library only. Upserts on name_en, so it is safe to run again after
refreshing main-site/data/. Rows are never deleted: a round may point at one.
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
STATIONS = ROOT / "main-site" / "data" / "stations.geojson"
TABLE = "mrtguessr_stations"

# Station code prefix to line code. Must match PREFIXES in
# main-site/api/_lib/lines.js.
PREFIX_TO_LINE = {
    "NS": "NS",
    "EW": "EW",
    "CG": "EW",
    "NE": "NE",
    "CC": "CC",
    "CE": "CC",
    "DT": "DT",
    "TE": "TE",
    "BP": "BP",
    "SE": "SK",
    "SW": "SK",
    "STC": "SK",
    "PE": "PG",
    "PW": "PG",
    "PTC": "PG",
}


def load_env_file(path: Path) -> None:
    """A .env beside this script or at the repo root, without overriding."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        os.environ.setdefault(key.strip(), value)


def build_rows() -> list[dict]:
    features = json.loads(STATIONS.read_text(encoding="utf-8"))["features"]
    by_name: dict[str, dict] = {}
    unknown: set[str] = set()

    for feature in features:
        p = feature.get("properties") or {}
        name = re.sub(r"\s+", " ", (p.get("name") or "")).strip()
        if not name:
            continue
        codes = [c.strip() for c in p.get("codes") or [] if c and c.strip()]
        lon, lat = (feature.get("geometry") or {}).get("coordinates") or (None, None)

        # Upstream ids are not unique and an interchange can appear more than
        # once, so the English name is the key and codes are merged.
        row = by_name.setdefault(
            name.casefold(),
            {
                "name_en": name,
                "name_zh": p.get("name_zh") or None,
                "name_ta": p.get("name_ta") or None,
                "codes": [],
                "lines": [],
                "lat": lat,
                "lon": lon,
            },
        )
        for code in codes:
            if code in row["codes"]:
                continue
            row["codes"].append(code)
            prefix = re.match(r"[A-Z]+", code)
            line = PREFIX_TO_LINE.get(prefix.group(0) if prefix else "")
            if line is None:
                unknown.add(code)
            elif line not in row["lines"]:
                row["lines"].append(line)
        row["name_zh"] = row["name_zh"] or p.get("name_zh") or None
        row["name_ta"] = row["name_ta"] or p.get("name_ta") or None

    if unknown:
        sys.exit(f"unknown station code prefixes, add them to PREFIX_TO_LINE: {sorted(unknown)}")

    rows = [r for r in by_name.values() if r["codes"] and r["lat"] is not None]
    rows.sort(key=lambda r: r["name_en"])
    return rows


def request(method: str, path: str, body=None, prefer: str | None = None):
    url = f"{os.environ['SUPABASE_URL'].rstrip('/')}/rest/v1/{path}"
    key = os.environ["SUPABASE_SERVICE_KEY"]
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if prefer:
        headers["Prefer"] = prefer
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            text = res.read().decode("utf-8")
            return res.status, json.loads(text) if text else None
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode("utf-8", "replace")


SEED_SQL = ROOT / "migrations" / "002_mrtguessr_seed_stations.sql"


def sql_text(value) -> str:
    return "null" if value is None else "'" + str(value).replace("'", "''") + "'"


def sql_array(values) -> str:
    return "array[" + ", ".join(sql_text(v) for v in values) + "]::text[]"


def write_sql(rows: list[dict]) -> None:
    values = ",\n".join(
        f"  ({sql_text(r['name_en'])}, {sql_text(r['name_zh'])}, {sql_text(r['name_ta'])}, "
        f"{sql_array(r['codes'])}, {sql_array(r['lines'])}, {r['lat']}, {r['lon']})"
        for r in rows
    )
    SEED_SQL.write_text(
        "-- Stations for mrtguessr_stations. Generated by\n"
        "-- `python scripts/seed_supabase.py --sql` from main-site/data/stations.geojson;\n"
        "-- regenerate rather than edit. Run after 001. Safe to run again: it\n"
        "-- updates stations by English name and never deletes one.\n\n"
        "insert into mrtguessr_stations (name_en, name_zh, name_ta, codes, lines, lat, lon)\nvalues\n"
        f"{values}\n"
        "on conflict (name_en) do update set\n"
        "  name_zh = excluded.name_zh,\n"
        "  name_ta = excluded.name_ta,\n"
        "  codes = excluded.codes,\n"
        "  lines = excluded.lines,\n"
        "  lat = excluded.lat,\n"
        "  lon = excluded.lon;\n",
        encoding="utf-8",
        newline="\n",
    )


def main() -> int:
    # Chinese and Tamil names, on a Windows console that defaults to cp1252.
    sys.stdout.reconfigure(encoding="utf-8")
    dry_run = "--dry-run" in sys.argv[1:]
    rows = build_rows()
    interchanges = sum(1 for r in rows if len(r["codes"]) > 1)
    missing_zh = [r["name_en"] for r in rows if not r["name_zh"]]
    print(f"{len(rows)} stations from {STATIONS.relative_to(ROOT)}, {interchanges} interchanges")
    if missing_zh:
        print(f"no Chinese name, tier 4 hint will be skipped for: {', '.join(missing_zh)}")

    if dry_run:
        print(json.dumps(rows[:3], ensure_ascii=False, indent=2))
        return 0

    if "--sql" in sys.argv[1:]:
        write_sql(rows)
        print(f"wrote {SEED_SQL.relative_to(ROOT)}")
        return 0

    load_env_file(Path(__file__).resolve().parent / ".env")
    load_env_file(ROOT / ".env")
    missing = [n for n in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY") if not os.environ.get(n)]
    if missing:
        print(f"missing: {', '.join(missing)}", file=sys.stderr)
        return 2

    status, body = request("GET", f"{TABLE}?select=id&limit=1")
    if status != 200:
        print(
            f"{TABLE} is not reachable ({status}). Run the SQL in migrations/ first.\n{body}",
            file=sys.stderr,
        )
        return 1

    status, body = request(
        "POST",
        f"{TABLE}?on_conflict=name_en",
        rows,
        prefer="resolution=merge-duplicates,return=minimal",
    )
    if status not in (200, 201, 204):
        print(f"upsert failed ({status}):\n{body}", file=sys.stderr)
        return 1

    status, body = request("GET", f"{TABLE}?select=id")
    print(f"done, {len(body) if isinstance(body, list) else '?'} rows in {TABLE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
