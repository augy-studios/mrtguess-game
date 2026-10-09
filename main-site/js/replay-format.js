// The replay format, shared by the API that stores replays and the page that
// plays them. A replay is what happened, not what it scored: every score is
// worked out again from the events by js/rules.js, so a replay cannot claim
// points its events do not add up to.
//
// {
//   v: 1,
//   kind: "solo" | "party",
//   at: ISO time the game started,
//   settings: { difficulty, turn },          turn in seconds, or null
//   players: ["Augy", "Ben"],
//   turns: [{
//     station: "Toa Payoh",                   English name, as in stations.geojson
//     order: [3, 0, 5],                       letter positions, in the order they show
//     end: 61250,                             ms the turn lasted
//     events: [[...], null],                  per player, in `players` order; null for
//   }]                                        somebody not in that turn
// }
//
// Events are js/rules.js's: [t, "h", tier], [t, "g", text], [t, "x"].

import { MAX_EVENTS, cleanDifficulty, cleanTurn, turnMs } from "./rules.js";

export const REPLAY_VERSION = 1;
export const MAX_PLAYERS = 8;
export const MAX_TURNS = 200;
const MAX_LETTERS = 64;

// Control characters out, whitespace collapsed, cut to `max` characters.
export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  const text = value.normalize("NFKC").replace(/\p{C}/gu, "").replace(/\s+/gu, " ").trim();
  return Array.from(text).slice(0, max).join("").trim();
}

function int(value, min, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min;
}

function cleanEvents(list, end) {
  if (!Array.isArray(list)) return null;
  const out = [];
  let last = 0;
  for (const e of list.slice(0, MAX_EVENTS)) {
    if (!Array.isArray(e)) continue;
    // In time order, and inside the turn.
    const t = int(e[0], last, end);
    last = t;
    if (e[1] === "h") out.push([t, "h", int(e[2], 2, 5)]);
    else if (e[1] === "g") {
      const text = cleanText(e[2], 64);
      if (text) out.push([t, "g", text]);
    } else if (e[1] === "x") out.push([t, "x"]);
  }
  return out;
}

// A replay from anywhere (a link, the API, a party host) made safe to use,
// or null if it is not one.
export function cleanReplay(raw) {
  if (!raw || typeof raw !== "object" || raw.v !== REPLAY_VERSION) return null;
  const kind = raw.kind === "solo" || raw.kind === "party" ? raw.kind : null;
  if (!kind) return null;

  const settings = { difficulty: cleanDifficulty(raw.settings?.difficulty), turn: cleanTurn(raw.settings?.turn) };
  const limit = turnMs(settings.turn);

  const players = (Array.isArray(raw.players) ? raw.players.slice(0, MAX_PLAYERS) : []).map(
    (p, i) => cleanText(p, 20) || `Player ${i + 1}`
  );
  if (!players.length) return null;

  const turns = [];
  for (const t of Array.isArray(raw.turns) ? raw.turns.slice(0, MAX_TURNS) : []) {
    const station = cleanText(t?.station, 40);
    if (!station) continue;
    const end = int(t.end, 0, limit);
    const order = [...new Set((Array.isArray(t.order) ? t.order : []).map((x) => int(x, 0, MAX_LETTERS - 1)))].slice(0, MAX_LETTERS);
    const events = players.map((_, i) => cleanEvents(t.events?.[i], end));
    turns.push({ station, order, end, events });
  }
  if (!turns.length) return null;

  const at = typeof raw.at === "string" && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : null;
  return { v: REPLAY_VERSION, kind, at, settings, players, turns };
}

/* ---- the long link ----
   Offline, or when the API will not store it, a replay travels in the link
   itself: the JSON, deflated where the browser can, as base64url. "z" or "j"
   in front says which. */

function toBase64Url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function through(stream, bytes) {
  const out = new Blob([bytes]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function packReplay(replay) {
  const json = new TextEncoder().encode(JSON.stringify(replay));
  if (typeof CompressionStream === "function") {
    try {
      return `z${toBase64Url(await through(new CompressionStream("deflate-raw"), json))}`;
    } catch {
      // Fall through to the plain form.
    }
  }
  return `j${toBase64Url(json)}`;
}

export async function unpackReplay(packed) {
  const text = String(packed ?? "");
  const bytes = fromBase64Url(text.slice(1));
  if (!bytes || bytes.length > 512 * 1024) return null;
  try {
    let json = bytes;
    if (text[0] === "z") {
      if (typeof DecompressionStream !== "function") return null;
      json = await through(new DecompressionStream("deflate-raw"), bytes);
    } else if (text[0] !== "j") {
      return null;
    }
    return cleanReplay(JSON.parse(new TextDecoder().decode(json)));
  } catch {
    return null;
  }
}
