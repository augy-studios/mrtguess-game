#!/usr/bin/env node
// Builds main-site/data/ from a local clone of cheeaun/sgraildata.
//
// Keeps stations and line geometry only. Exits and station buildings are
// incomplete upstream and this app does not use them.
//
// Run: node scripts/vendor-sgraildata.mjs <path to sgraildata clone>

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const clone = process.argv[2];
if (!clone) {
  console.error("usage: node scripts/vendor-sgraildata.mjs <path to sgraildata clone>");
  process.exit(1);
}

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "main-site", "data");

// Upstream line name to the line code js/lines.js keys on. Colours and
// display names live there, not here.
const LINE_CODES = {
  "North South Line": "NS",
  "East West Line": "EW",
  "North East Line": "NE",
  "Circle Line": "CC",
  "Downtown Line": "DT",
  "Thomson-East Coast Line": "TE",
  "Bukit Panjang LRT": "BP",
  "Sengkang LRT (East Loop)": "SK",
  "Sengkang LRT (West Loop)": "SK",
  "Punggol LRT (East Loop)": "PG",
  "Punggol LRT (West Loop)": "PG",
};

// About 1 m at 5 places and 10 cm at 6. Upstream lines are already smoothed.
const round = (n, places) => Math.round(n * 10 ** places) / 10 ** places;
const roundCoords = (c, places) =>
  typeof c[0] === "number" ? c.map((n) => round(n, places)) : c.map((x) => roundCoords(x, places));

const source = JSON.parse(readFileSync(join(clone, "data", "v1", "sg-rail.geojson"), "utf8"));

const stations = [];
const lines = [];
const unknown = new Set();

for (const f of source.features) {
  const p = f.properties;

  if (p.stop_type === "station") {
    stations.push({
      type: "Feature",
      properties: {
        name: p.name,
        name_zh: p["name_zh-Hans"] ?? "",
        name_ta: p.name_ta ?? "",
        // Interchanges arrive as one feature with joined codes, "NS17-CC15".
        codes: p.station_codes.split("-").filter(Boolean),
      },
      geometry: { type: "Point", coordinates: roundCoords(f.geometry.coordinates, 6) },
    });
    continue;
  }

  if (f.geometry.type === "LineString" || f.geometry.type === "MultiLineString") {
    const line = LINE_CODES[p.name];
    if (!line) {
      unknown.add(p.name);
      continue;
    }
    lines.push({
      type: "Feature",
      properties: { line, name: p.name },
      geometry: { type: f.geometry.type, coordinates: roundCoords(f.geometry.coordinates, 5) },
    });
  }
}

if (unknown.size) {
  console.error(`unknown line names, add them to LINE_CODES: ${[...unknown].join(", ")}`);
  process.exit(1);
}

stations.sort((a, b) => a.properties.name.localeCompare(b.properties.name));

let commit = "unknown";
try {
  commit = execFileSync("git", ["-C", clone, "log", "-1", "--format=%H %cs"], { encoding: "utf8" }).trim();
} catch {
  // Not a git clone. The snapshot still builds; the README just cannot say which one.
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "stations.geojson"), JSON.stringify({ type: "FeatureCollection", features: stations }));
writeFileSync(join(OUT, "lines.geojson"), JSON.stringify({ type: "FeatureCollection", features: lines }));

console.log(`${stations.length} stations, ${lines.length} line features, from sgraildata ${commit}`);
