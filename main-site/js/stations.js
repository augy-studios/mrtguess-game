// The station list in the browser, for the party host (which picks and
// judges stations itself) and the replay viewer (which shows their hints).
// From the precached data/stations.geojson, so it loads offline.

import { stationsFromGeojson } from "./rules.js";

let loading = null;

export function loadStations() {
  loading ??= fetch("/data/stations.geojson")
    .then((r) => {
      if (!r.ok) throw new Error(`stations ${r.status}`);
      return r.json();
    })
    .then((data) => {
      const rows = stationsFromGeojson(data);
      if (!rows.length) throw new Error("no stations");
      return { rows, byName: new Map(rows.map((s) => [s.name_en.toLowerCase(), s])) };
    });
  loading.catch(() => (loading = null));
  return loading;
}
