# vendor

Third-party code served from this origin rather than a CDN, so it is
precached and works offline.

- `leaflet/`: [Leaflet](https://leafletjs.com) 1.9.4, BSD-2-Clause
  (`leaflet/LICENSE.txt`). `leaflet.js` and `leaflet.css` unchanged from the
  npm package's `dist/`. For the tier 3 map hint (`js/map.js`), drawn with
  no tile layer: the network lines and a ring, no labels. Loaded by a script
  tag the first time a map hint is bought, not with the page.

To upgrade, copy the two files from the new package's `dist/`, update the
version above, and bump `VERSION` in `sw.js`.
