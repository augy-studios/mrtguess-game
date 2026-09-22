// The game rules. Every client calls through here; nothing below is
// duplicated in a client.
//
// Hint ladder, all derived from the station row:
//   1  line colour          given with the round, free
//   2  station codes        -100, in full: NS19, or NS24 NE6 CC1
//   3  position on a map    -150
//   4  Chinese name         -200
//   5  one more letter      -60 each, until half the letters show
//
// Letters also reveal on their own, one every 15 seconds, at the same -60
// each and up to the same limit. The clock is the server's: a reveal is due
// from created_at, whoever asks and whenever.

import { randomInt } from "node:crypto";
import { rest } from "./supabase.js";
import { HttpError } from "./http.js";
import { colorsFor, lineNamesFor } from "./lines.js";

export const START_SCORE = 1000;
export const REVEAL_EVERY_MS = 15_000;
export const LETTER_COST = 60;
export const WRONG_GUESS_COST = 20;
export const MIN_SCORE = 50;
export const ROUND_TTL_MS = 60 * 60 * 1000;
export const TIER_COST = { 2: 100, 3: 150, 4: 200, 5: LETTER_COST };
export const LAST_TIER = 5;

const STATIONS_TTL_MS = 60 * 60 * 1000;
let stationsCache = null;

// 184 rows, read once per warm instance.
export async function stations() {
  if (stationsCache && Date.now() - stationsCache.at < STATIONS_TTL_MS) return stationsCache.rows;
  const rows = await rest("mrtguessr_stations?select=id,name_en,name_zh,codes,lines,lat,lon");
  if (!rows?.length) throw new HttpError(503, "no_stations", "Station data is not loaded yet.");
  stationsCache = { at: Date.now(), rows, byId: new Map(rows.map((s) => [s.id, s])) };
  return rows;
}

export async function stationById(id) {
  await stations();
  const station = stationsCache.byId.get(id);
  if (!station) throw new HttpError(500, "missing_station");
  return station;
}

// Recent answers for this player are skipped, so replays do not repeat.
export async function pickStation(clientKey) {
  const all = await stations();
  const recent = await rest(
    `mrtguessr_rounds?select=station_id&client_key=eq.${encodeURIComponent(clientKey)}&order=created_at.desc&limit=40`
  );
  const skip = new Set((recent ?? []).map((r) => r.station_id));
  const pool = all.filter((s) => !skip.has(s.id));
  const from = pool.length ? pool : all;
  return from[randomInt(from.length)];
}

const isLetter = (ch) => /\p{L}/u.test(ch);

export function letterPositions(name) {
  return [...name].flatMap((ch, i) => (isLetter(ch) ? [i] : []));
}

export function maxReveals(name) {
  return Math.floor(letterPositions(name).length / 2);
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

const finished = (round) => round.solved || round.gave_up;
const expired = (round, now) => now - Date.parse(round.created_at) > ROUND_TTL_MS;

function revealRandom(round, name, count) {
  const shown = new Set(round.revealed_positions);
  const hidden = letterPositions(name).filter((i) => !shown.has(i));
  const added = [];
  for (let n = 0; n < count && hidden.length; n++) {
    added.push(hidden.splice(randomInt(hidden.length), 1)[0]);
  }
  round.revealed_positions = [...round.revealed_positions, ...added].sort((a, b) => a - b);
  round.score = Math.max(MIN_SCORE, round.score - added.length * LETTER_COST);
  return added.length;
}

// Applies every clock reveal that has come due. Returns whether it changed
// anything, so a read with nothing due costs no write.
export function applyClock(round, station, now = Date.now()) {
  if (finished(round) || expired(round, now)) return false;
  const room = maxReveals(station.name_en) - round.revealed_positions.length;
  const due = Math.floor((now - Date.parse(round.created_at)) / REVEAL_EVERY_MS);
  const clockDone = round.revealed_positions.length - round.letters_bought;
  const count = Math.min(due - clockDone, room);
  return count > 0 && revealRandom(round, station.name_en, count) > 0;
}

function nextHint(round, station) {
  if (finished(round)) return null;
  const tier = round.hint_tier + 1;
  if (tier < LAST_TIER) return { tier, penalty: TIER_COST[tier] };
  if (round.revealed_positions.length < maxReveals(station.name_en)) return { tier: LAST_TIER, penalty: LETTER_COST };
  return null;
}

// Buys the next rung. Throws when there is nothing left to buy.
export function applyHint(round, station) {
  const next = nextHint(round, station);
  if (!next) throw new HttpError(409, "no_more_hints", "There are no more hints for this station.");
  if (next.tier < LAST_TIER) {
    round.hint_tier = next.tier;
    round.score = Math.max(MIN_SCORE, round.score - next.penalty);
  } else {
    round.hint_tier = LAST_TIER;
    revealRandom(round, station.name_en, 1);
    round.letters_bought += 1;
  }
  return next.penalty;
}

export function applyGuess(round, station, guess) {
  const correct = normaliseGuess(guess) === normaliseGuess(station.name_en);
  if (correct) {
    round.solved = true;
    round.finished_at = new Date().toISOString();
  } else {
    round.score = Math.max(MIN_SCORE, round.score - WRONG_GUESS_COST);
  }
  return correct;
}

export function applyGiveUp(round) {
  round.gave_up = true;
  round.score = 0;
  round.finished_at = new Date().toISOString();
}

export function assertPlayable(round, now = Date.now()) {
  if (finished(round)) throw new HttpError(409, "round_over", "This round is already over.");
  if (expired(round, now)) throw new HttpError(410, "round_expired", "This round has expired. Start a new one.");
}

// What a client may see. The station's name only appears once the round is
// over, and each hint only once its tier is bought.
export function view(round, station, now = Date.now()) {
  const tier = round.hint_tier;
  const over = finished(round);
  const hints = { colors: colorsFor(station.lines) };
  if (tier >= 2) {
    hints.codes = station.codes;
    hints.line_names = lineNamesFor(station.lines);
  }
  // Rounded to about 100 m: enough for a dot on a map.
  if (tier >= 3) hints.position = { lat: +station.lat.toFixed(3), lon: +station.lon.toFixed(3) };
  if (tier >= 4 && station.name_zh) hints.name_zh = station.name_zh;

  let nextRevealIn = null;
  if (!over && !expired(round, now) && round.revealed_positions.length < maxReveals(station.name_en)) {
    const clockDone = round.revealed_positions.length - round.letters_bought;
    nextRevealIn = Math.max(0, Date.parse(round.created_at) + (clockDone + 1) * REVEAL_EVERY_MS - now);
  }

  const out = {
    round_id: round.id,
    mask: maskOf(station.name_en, round.revealed_positions, over),
    length: letterPositions(station.name_en).length,
    hint_tier: tier,
    line_color: hints.colors[0]?.hex ?? null,
    hints,
    score: round.score,
    solved: round.solved,
    gave_up: round.gave_up,
    expired: !over && expired(round, now),
    next_reveal_in: nextRevealIn,
    next_hint: nextHint(round, station),
    created_at: round.created_at,
  };
  if (over) {
    out.answer = { name_en: station.name_en, name_zh: station.name_zh, name_ta: station.name_ta, codes: station.codes };
  }
  return out;
}

const WRITABLE = ["hint_tier", "revealed_positions", "score", "solved", "gave_up", "finished_at", "letters_bought"];

export async function loadRound(id, clientKey) {
  const rows = await rest(`mrtguessr_rounds?id=eq.${id}&select=*`);
  const round = rows?.[0];
  // Someone else's round reads as no round at all.
  if (!round || round.client_key !== clientKey) throw new HttpError(404, "round_not_found");
  return round;
}

// Load, change, write back only if nobody else wrote in between; otherwise
// start again from the fresh row. `change` returns false to skip the write.
export async function updateRound(id, clientKey, change) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const round = await loadRound(id, clientKey);
    const station = await stationById(round.station_id);
    const result = change(round, station);
    if (result?.write === false) return { round, station, result };

    const patch = Object.fromEntries(WRITABLE.map((k) => [k, round[k]]));
    patch.version = round.version + 1;
    const saved = await rest(`mrtguessr_rounds?id=eq.${id}&version=eq.${round.version}`, {
      method: "PATCH",
      body: patch,
      prefer: "return=representation",
    });
    if (saved?.length) return { round: saved[0], station, result };
  }
  throw new HttpError(409, "busy", "That round is busy. Try again.");
}
