// The tier 3 hint: the rail network with no labels and no street map, and a
// ring where the station is. telegram-bot/mapimage.py draws the same picture.
// Leaflet loads on the first map hint, not with the page.

// Same colours as api/_lib/lines.js. Fixed meaning: they are the lines' own.
const LINE_COLOURS = {
  NS: "#d42e12", EW: "#009645", NE: "#9900aa", CC: "#fa9e0d", DT: "#005ec4",
  TE: "#9d5b25", BP: "#748477", SK: "#748477", PG: "#748477",
};

let leaflet = null;
let network = null;
let map = null;
let linesLayer = null;
let ring = null;

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

  if (!map) {
    map = L.map(el, {
      attributionControl: true,
      scrollWheelZoom: false,
      zoomSnap: 0.25,
      keyboard: false,
    });
    map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
    linesLayer = L.geoJSON(data, {
      interactive: false,
      attribution: '<a href="https://github.com/cheeaun/sgraildata">sgraildata</a>',
      style: (f) => ({ color: LINE_COLOURS[f.properties.line] ?? "#748477", weight: 3, opacity: 1 }),
    }).addTo(map);
  }

  map.invalidateSize();
  map.fitBounds(linesLayer.getBounds(), { padding: [10, 10] });

  ring?.remove();
  ring = L.marker([position.lat, position.lon], {
    icon: L.divIcon({ className: "station-ring", html: "<span></span>", iconSize: [40, 40] }),
    interactive: false,
    keyboard: false,
  }).addTo(map);
}

export function clearStation() {
  ring?.remove();
  ring = null;
}
