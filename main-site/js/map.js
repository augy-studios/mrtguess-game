// The tier 3 hint: the rail network with no labels and no street map, and a
// ring where the station is. telegram-bot/mapimage.py draws the same picture.
// Leaflet loads on the first map hint, not with the page. Each element gets
// its own map: the solo round, a party turn and a replay each have one.

import { LINES } from "./rules.js";

let leaflet = null;
let network = null;
const maps = new Map(); // element -> { map, lines, ring }

function loadLeaflet() {
  leaflet ??= new Promise((resolve, reject) => {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = "/vendor/leaflet/leaflet.css";
    document.head.append(css);

    const script = document.createElement("script");
    script.src = "/vendor/leaflet/leaflet.js";
    script.onload = () => resolve(window.L);
    script.onerror = () => {
      leaflet = null;
      reject(new Error("leaflet did not load"));
    };
    document.head.append(script);
  });
  return leaflet;
}

function loadNetwork() {
  network ??= fetch("/data/lines.geojson").then((r) => {
    if (!r.ok) throw new Error(`lines ${r.status}`);
    return r.json();
  });
  network.catch(() => (network = null));
  return network;
}

// Draws into `el`, which must already be showing so Leaflet can measure it.
export async function showStation(el, position) {
  const [L, data] = await Promise.all([loadLeaflet(), loadNetwork()]);

  let entry = maps.get(el);
  if (!entry) {
    const map = L.map(el, {
      attributionControl: true,
      scrollWheelZoom: false,
      zoomSnap: 0.25,
      keyboard: false,
    });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    const lines = L.geoJSON(data, {
      interactive: false,
      attribution: '<a href="https://github.com/cheeaun/sgraildata">sgraildata</a>',
      style: (f) => ({ color: LINES[f.properties.line]?.color ?? "#748477", weight: 3, opacity: 1 }),
    }).addTo(map);
    entry = { map, lines, ring: null };
    maps.set(el, entry);
  }

  entry.map.invalidateSize();
  entry.map.fitBounds(entry.lines.getBounds(), { padding: [10, 10] });

  entry.ring?.remove();
  entry.ring = L.marker([position.lat, position.lon], {
    icon: L.divIcon({ className: "station-ring", html: "<span></span>", iconSize: [40, 40] }),
    interactive: false,
    keyboard: false,
  }).addTo(entry.map);
}

export function clearStation(el) {
  const entry = maps.get(el);
  entry?.ring?.remove();
  if (entry) entry.ring = null;
}
