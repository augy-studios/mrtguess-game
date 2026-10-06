// Line codes, names and colours. The codes are what mrtguessr_stations.lines
// holds; PREFIXES must match PREFIX_TO_LINE in scripts/seed_supabase.py.

export const LINES = {
  NS: { name: "North-South Line", color: "#d42e12", colorName: "red" },
  EW: { name: "East-West Line", color: "#009645", colorName: "green" },
  NE: { name: "North East Line", color: "#9900aa", colorName: "purple" },
  CC: { name: "Circle Line", color: "#fa9e0d", colorName: "orange" },
  DT: { name: "Downtown Line", color: "#005ec4", colorName: "blue" },
  TE: { name: "Thomson-East Coast Line", color: "#9d5b25", colorName: "brown" },
  // The LRTs share a grey; the letter says which one, to make them easier.
  BP: { name: "Bukit Panjang LRT", color: "#748477", colorName: "grey(B)" },
  SK: { name: "Sengkang LRT", color: "#748477", colorName: "grey(S)" },
  PG: { name: "Punggol LRT", color: "#748477", colorName: "grey(P)" },
};

export const PREFIXES = {
  NS: "NS", EW: "EW", CG: "EW", NE: "NE", CC: "CC", CE: "CC", DT: "DT", TE: "TE",
  BP: "BP", SE: "SK", SW: "SK", STC: "SK", PE: "PG", PW: "PG", PTC: "PG",
};

// Tier 1: colours only, each colour name once.
export function colorsFor(lineCodes) {
  const seen = new Map();
  for (const code of lineCodes) {
    const line = LINES[code];
    if (line && !seen.has(line.colorName)) seen.set(line.colorName, { hex: line.color, name: line.colorName });
  }
  return [...seen.values()];
}

export function lineNamesFor(lineCodes) {
  return lineCodes.map((c) => LINES[c]?.name).filter(Boolean);
}
