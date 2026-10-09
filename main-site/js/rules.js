// The game's rules, in one file for everything that applies them: the API's
// solo rounds (api/_lib/game.js imports this file), the party host, and the
// replay viewer, which works every score out again from what happened.
//
// Pure: no DOM, no network, no clock and no randomness of its own, so the
// server and a browser given the same events always agree on the points.
//
// A turn is one station. What a player did in it is a list of events, each
// [ms since the turn started, kind, data]:
//
//   [t, "h", tier]   bought a hint; tier 5 is one more letter
//   [t, "g", text]   guessed; right or wrong is worked out from the name
//   [t, "x"]         gave up
//
// Everything else, the letters showing, the score, whether it is solved, is
// derived from those by turnState().
//
// Hint ladder:
//   1  line colour          given with the round, free
//   2  station codes        -100, in full: NS19, or NS24 NE6 CC1
//   3  position on a map    -150
//   4  Chinese name         -200
//   5  one more letter      -60 each, up to the difficulty's share of letters
//
// Letters also show on their own as the clock runs, at the same -60 each and
// up to the same share. They come in one order per turn, shuffled when it
// starts, so everybody in a party sees the same letters and a bought letter
// is simply the next one the clock would have shown.

export const START_SCORE = 1000;
export const LETTER_COST = 60;
export const WRONG_GUESS_COST = 20;
export const MIN_SCORE = 50;
export const TIER_COST = { 2: 100, 3: 150, 4: 200, 5: LETTER_COST };
export const LAST_TIER = 5;
export const HINT_LABELS = { 2: "Station code", 3: "Map", 4: "Chinese name", 5: "Letter" };

// Harder: the clock shows letters more slowly and stops sooner, and every
// point counts for more. `share` is the most letters that can ever show, as
// a fraction of the name's letters.
export const DIFFICULTIES = {
  easy: { label: "Easy", revealEveryMs: 10_000, share: [2, 3], multiplier: 0.75 },
  normal: { label: "Normal", revealEveryMs: 15_000, share: [1, 2], multiplier: 1 },
  hard: { label: "Hard", revealEveryMs: 20_000, share: [1, 3], multiplier: 1.5 },
};
export const DEFAULT_DIFFICULTY = "normal";

// Time limits for a turn, in seconds, and what each multiplies points by. A
// timed turn also earns up to SPEED_BONUS more for time left on the clock.
// No limit (null) is solo's default and the bots': a round then lasts an
// hour, scores as a two minute one, and has no speed bonus.
export const TURN_LIMITS = { 30: 1.5, 60: 1.2, 120: 1 };
export const SPEED_BONUS = 0.5;
export const UNTIMED_MS = 60 * 60 * 1000;
export const PARTY_TURN_DEFAULT = 120;

// The most events one player may make in one turn. Keeps a replay, and a
// stored round, a sensible size whatever a script sends.
export const MAX_EVENTS = 60;

export const difficultyOf = (id) => DIFFICULTIES[id] ?? DIFFICULTIES[DEFAULT_DIFFICULTY];

export function cleanDifficulty(value) {
  return Object.hasOwn(DIFFICULTIES, value) ? value : DEFAULT_DIFFICULTY;
}

// A limit in seconds, or null for none. Anything else is null.
export function cleanTurn(value) {
  const n = Number(value);
  return Object.hasOwn(TURN_LIMITS, String(n)) ? n : null;
}

export const turnMs = (turn) => (turn ? turn * 1000 : UNTIMED_MS);

export function describeTurn(turn) {
  if (!turn) return "No time limit";
  return turn < 60 ? `${turn} seconds` : turn === 60 ? "1 minute" : `${turn / 60} minutes`;
}

/* ---- names and masks ---- */

const isLetter = (ch) => /\p{L}/u.test(ch);

export function letterPositions(name) {
  return [...name].flatMap((ch, i) => (isLetter(ch) ? [i] : []));
}

export function maxReveals(name, difficulty) {
  const [num, den] = difficultyOf(difficulty).share;
  return Math.floor((letterPositions(name).length * num) / den);
}

// "_" for a hidden letter. Spaces and hyphens show, as word shapes do in
// Skribbl.
export function maskOf(name, revealed, full = false) {
  const shown = new Set(revealed);
  return [...name].map((ch, i) => (!isLetter(ch) || full || shown.has(i) ? ch : "_")).join("");
}

// Case, spacing, hyphens and accents ignored: "toapayoh" is "Toa Payoh".
export function normaliseGuess(text) {
  return String(text)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function isCorrect(guess, name) {
  const g = normaliseGuess(guess);
  return g.length > 0 && g === normaliseGuess(name);
}

// Fisher-Yates with the caller's randomInt(n), which returns 0 to n - 1:
// node:crypto's on the server, crypto.getRandomValues in a browser.
export function shuffle(list, randomInt) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ---- the clock and the score ---- */

// Letters showing `elapsed` ms into a turn, `bought` of them bought.
export function revealedCount(name, difficulty, elapsed, bought) {
  const due = Math.max(0, Math.floor(elapsed / difficultyOf(difficulty).revealEveryMs));
  return Math.min(maxReveals(name, difficulty), due + bought);
}

// Ms until the clock shows another letter, or null if it will not before
// `limit`.
export function nextRevealIn(name, difficulty, elapsed, bought, limit) {
  if (revealedCount(name, difficulty, elapsed, bought) >= maxReveals(name, difficulty)) return null;
  const every = difficultyOf(difficulty).revealEveryMs;
  const at = (Math.floor(Math.max(0, elapsed) / every) + 1) * every;
  return at < limit ? at - elapsed : null;
}

function tierCost(tier) {
  let cost = 0;
  for (let t = 2; t <= Math.min(tier, LAST_TIER - 1); t++) cost += TIER_COST[t];
  return cost;
}

export function baseScore(tier, revealed, wrong) {
  return Math.max(MIN_SCORE, START_SCORE - tierCost(tier) - revealed * LETTER_COST - wrong * WRONG_GUESS_COST);
}

export function nextHint(tier, revealed, name, difficulty) {
  const next = tier + 1;
  if (next < LAST_TIER) return { tier: next, penalty: TIER_COST[next] };
  if (revealed < maxReveals(name, difficulty)) return { tier: LAST_TIER, penalty: LETTER_COST };
  return null;
}

// What a solve `elapsed` ms in is multiplied by, each factor to two places
// so the breakdown shown multiplies out to the points shown.
export function multipliers({ difficulty, turn }, elapsed) {
  const out = { difficulty: difficultyOf(difficulty).multiplier, timer: 1, speed: 1 };
  const limit = TURN_LIMITS[turn];
  if (limit) {
    const left = Math.max(0, Math.min(1, 1 - elapsed / turnMs(turn)));
    out.timer = limit;
    out.speed = Math.round((1 + SPEED_BONUS * left) * 100) / 100;
  }
  return out;
}

export function turnPoints(base, settings, elapsed) {
  const m = multipliers(settings, elapsed);
  return Math.round(base * m.difficulty * m.timer * m.speed);
}

// A game's total is multiplied by its length: 1 for 5 stations, 1.25 for 10,
// 1.5 for 20, a quarter more for every doubling, and a little less than 1
// below 5.
export function lengthMultiplier(stations) {
  const n = Math.max(1, Math.floor(stations) || 1);
  const raw = n >= 5 ? 1 + 0.25 * Math.log2(n / 5) : 0.8 + 0.05 * (n - 1);
  return Math.round(raw * 100) / 100;
}

export const gameScore = (total, stations) => Math.round(total * lengthMultiplier(stations));

/* ---- one player's turn ---- */

// The turn as it stood `t` ms in, from that player's events. `end` is when
// the turn closed for everybody: the time limit, or earlier when every
// player had finished. Events after it, or after the player finished, count
// for nothing.
export function turnState(name, settings, events, end, t) {
  const at = Math.min(t, end);
  let tier = 1;
  let bought = 0;
  let wrong = 0;
  let done = null; // { by: "solved" | "gave_up", t }
  const shown = [];

  for (const event of events ?? []) {
    const [et, kind, data] = event;
    if (done || et > at) break;
    shown.push(event);
    if (kind === "h") {
      if (data === LAST_TIER) bought += 1;
      tier = Math.max(tier, Math.min(LAST_TIER, data));
    } else if (kind === "g") {
      if (isCorrect(data, name)) done = { by: "solved", t: et };
      else wrong += 1;
    } else if (kind === "x") {
      done = { by: "gave_up", t: et };
    }
  }

  const frozen = done ? done.t : at;
  const revealed = revealedCount(name, settings.difficulty, frozen, bought);
  const base = baseScore(tier, revealed, wrong);
  return {
    tier,
    bought,
    wrong,
    revealed,
    base,
    done,
    events: shown,
    points: done?.by === "solved" ? turnPoints(base, settings, done.t) : 0,
  };
}

/* ---- stations and lines ---- */

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

// The hints a player has bought, from a station row.
export function hintsFor(station, tier) {
  const hints = { colors: colorsFor(station.lines) };
  if (tier >= 2) {
    hints.codes = station.codes;
    hints.line_names = lineNamesFor(station.lines);
  }
  // Rounded to about 100 m: enough for a dot on a map.
  if (tier >= 3) hints.position = { lat: +station.lat.toFixed(3), lon: +station.lon.toFixed(3) };
  if (tier >= 4 && station.name_zh) hints.name_zh = station.name_zh;
  return hints;
}

// Station rows from data/stations.geojson, built as scripts/seed_supabase.py
// builds mrtguessr_stations: one per English name, codes merged, lines from
// the code prefixes.
export function stationsFromGeojson(data) {
  const byName = new Map();
  for (const feature of data?.features ?? []) {
    const p = feature?.properties ?? {};
    const name = String(p.name ?? "").replace(/\s+/g, " ").trim();
    if (!name) continue;
    const [lon, lat] = feature.geometry?.coordinates ?? [];
    const key = name.toLowerCase();
    let row = byName.get(key);
    if (!row) {
      row = { name_en: name, name_zh: null, name_ta: null, codes: [], lines: [], lat, lon };
      byName.set(key, row);
    }
    row.name_zh ||= p.name_zh || null;
    row.name_ta ||= p.name_ta || null;
    for (const raw of p.codes ?? []) {
      const code = String(raw ?? "").trim();
      if (!code || row.codes.includes(code)) continue;
      row.codes.push(code);
      const line = PREFIXES[code.match(/^[A-Z]+/)?.[0]];
      if (line && !row.lines.includes(line)) row.lines.push(line);
    }
  }
  return [...byName.values()]
    .filter((r) => r.codes.length && Number.isFinite(r.lat) && Number.isFinite(r.lon))
    .sort((a, b) => a.name_en.localeCompare(b.name_en));
}
