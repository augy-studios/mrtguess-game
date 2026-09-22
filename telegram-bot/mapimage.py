"""The tier 3 hint as a picture: the rail network with no labels and no street
map, and a ring where the station is. Leaflet draws the same thing in the PWA;
Telegram needs a PNG.
"""

from __future__ import annotations

import io
import json
import math
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw

# Same colours as main-site/api/_lib/lines.js. The page tokens for light mode.
LINE_COLOURS = {
    "NS": "#d42e12", "EW": "#009645", "NE": "#9900aa", "CC": "#fa9e0d", "DT": "#005ec4",
    "TE": "#9d5b25", "BP": "#748477", "SK": "#748477", "PG": "#748477",
}
# Page background and ink from the site's light and dark themes.
STYLES = {
    "light": {"background": "#e8f3e9", "ink": "#121815"},
    "dark": {"background": "#141c17", "ink": "#eef2ef"},
}

WIDTH = 1000
PAD = 40
SCALE = 2  # drawn large and shrunk, for smooth lines


@lru_cache(maxsize=1)
def _network(path: str):
    features = json.loads(Path(path).read_text(encoding="utf-8"))["features"]
    lines = []
    for f in features:
        geom = f["geometry"]
        parts = geom["coordinates"] if geom["type"] == "MultiLineString" else [geom["coordinates"]]
        for part in parts:
            lines.append((f["properties"]["line"], part))
    lons = [p[0] for _, part in lines for p in part]
    lats = [p[1] for _, part in lines for p in part]
    return lines, (min(lons), min(lats), max(lons), max(lats))


def render(lines_geojson: Path, lat: float, lon: float, style: str = "light") -> io.BytesIO:
    colours = STYLES.get(style, STYLES["light"])
    lines, (x0, y0, x1, y1) = _network(str(lines_geojson))
    # Equirectangular, with longitude shrunk by cos(latitude): fine at 1.3 N.
    kx = math.cos(math.radians((y0 + y1) / 2))
    span_x, span_y = (x1 - x0) * kx, y1 - y0
    inner = WIDTH - 2 * PAD
    height = int(inner * span_y / span_x) + 2 * PAD

    def xy(lo, la):
        return (
            (PAD + (lo - x0) * kx / span_x * inner) * SCALE,
            (PAD + (y1 - la) / span_y * (height - 2 * PAD)) * SCALE,
        )

    img = Image.new("RGB", (WIDTH * SCALE, height * SCALE), colours["background"])
    draw = ImageDraw.Draw(img)
    for code, part in lines:
        draw.line([xy(lo, la) for lo, la in part], fill=LINE_COLOURS.get(code, "#748477"), width=5 * SCALE, joint="curve")

    cx, cy = xy(lon, lat)
    for radius, width in ((34, 5), (18, 7)):
        rr = radius * SCALE
        draw.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), outline=colours["ink"], width=width * SCALE)
    rr = 6 * SCALE
    draw.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=colours["ink"])

    img = img.resize((WIDTH, height), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    out.seek(0)
    out.name = "map.png"
    return out
