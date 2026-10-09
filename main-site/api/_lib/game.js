// Solo rounds. The rules themselves are in js/rules.js, shared with the party
// host and the replay viewer; this file stores a round, records what the
// player does as events, and works out from them what the player may see.
//
// A round row keeps its events and its letter order, and every other column
// that matters (score, solved, finished_at) is written from them by settle(),
// so the leaderboard's SQL reads the same numbers the rules give. The clock
// needs no writes: the letters showing are worked out from the time whenever
// the round is read.

import { randomInt } from "node:crypto";
import { rest } from "./supabase.js";
import { HttpError } from "./http.js";
import {
  START_SCORE,
  MAX_EVENTS,
  cleanDifficulty,
  cleanTurn,
  colorsFor,
  hintsFor,
  letterPositions,
  maskOf,
  multipliers,
  nextHint,
  nextRevealIn,
  shuffle,
  turnMs,
  turnState,
} from "../../js/rules.js";

export { START_SCORE };

// A guess sent in the last moment of a timed round still counts, as made at
// the moment time ran out.
const GRACE_MS = 2000;

const STATIONS_TTL_MS = 60 * 60 * 1000;
let stationsCache = null;

// 184 rows, read once per warm instance.
export async function stations() {
  if (stationsCache && Date.now() - stationsCache.at < STATIONS_TTL_MS) return stationsCache.rows;
  const rows = await rest("mrtguessr_stations?select=id,name_en,name_zh,name_ta,codes,lines,lat,lon");
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

// A new round's row. Difficulty and time limit come from the request; a bot
// sends neither and gets normal with no limit, the game as it always was.
export function newRoundRow(station, clientKey, body) {
  return {
    station_id: station.id,
    client_key: clientKey,
    hint_tier: 1,
    score: START_SCORE,
    difficulty: cleanDifficulty(body.difficulty),
    turn_seconds: cleanTurn(body.turn_seconds),
    reveal_order: shuffle(letterPositions(station.name_en), randomInt),
    events: [],
  };
}

const settingsOf = (round) => ({ difficulty: cleanDifficulty(round.difficulty), turn: cleanTurn(round.turn_seconds) });
const elapsedOf = (round, now) => now - Date.parse(round.created_at);
const finished = (round) => round.solved || round.gave_up;

// Rounds started before migration 006 have no letter order and no events,
// so the rules cannot work them out. They read as expired: give up to see the
// answer, then start another.
const legacy = (round) => !Array.isArray(round.reveal_order);

function stateOf(round, station, now) {
  const settings = settingsOf(round);
  const limit = turnMs(settings.turn);
  return { settings, limit, s: turnState(station.name_en, settings, round.events, limit, elapsedOf(round, now)) };
}

// Writes what the events add up to into the columns SQL and the bots read.
function settle(round, station, now) {
  const { s } = stateOf(round, station, now);
  round.hint_tier = s.tier;
  round.letters_bought = s.bought;
  round.revealed_positions = round.reveal_order.slice(0, s.revealed);
  round.solved = s.done?.by === "solved";
  round.gave_up = s.done?.by === "gave_up";
  // A solved round's score is its points, multipliers and all: that is what
  // mrtguessr_submit puts on the board.
  round.score = round.solved ? s.points : round.gave_up ? 0 : s.base;
  if (s.done && !round.finished_at) {
    round.finished_at = new Date(Date.parse(round.created_at) + s.done.t).toISOString();
  }
}

function record(round, station, now, event) {
  const { limit } = stateOf(round, station, now);
  // Held to the time limit, so a guess in the grace period counts as made
  // when time ran out.
  const t = Math.max(0, Math.min(elapsedOf(round, now), limit));
  round.events = [...(round.events ?? []), [t, ...event]];
  settle(round, station, now);
}

function roomForEvents(round) {
  if ((round.events?.length ?? 0) >= MAX_EVENTS) {
    throw new HttpError(409, "too_many", "That is enough for one round. Give up to see the answer.");
  }
}

// Buys the next rung. Throws when there is nothing left to buy.
export function applyHint(round, station, now = Date.now()) {
  roomForEvents(round);
  const { s } = stateOf(round, station, now);
  const next = nextHint(s.tier, s.revealed, station.name_en, round.difficulty);
  if (!next) throw new HttpError(409, "no_more_hints", "There are no more hints for this station.");
  record(round, station, now, ["h", next.tier]);
  return next.penalty;
}

export function applyGuess(round, station, guess, now = Date.now()) {
  roomForEvents(round);
  record(round, station, now, ["g", guess]);
  return round.solved;
}

export function applyGiveUp(round, station, now = Date.now()) {
  if (legacy(round)) {
    round.gave_up = true;
    round.score = 0;
    round.finished_at = new Date(now).toISOString();
    return;
  }
  record(round, station, now, ["x"]);
}

export function assertPlayable(round, now = Date.now()) {
  if (finished(round)) throw new HttpError(409, "round_over", "This round is already over.");
  const limit = legacy(round) ? 0 : turnMs(settingsOf(round).turn);
  if (elapsedOf(round, now) > limit + GRACE_MS) {
    throw new HttpError(410, "round_expired", "This round has run out of time. Start a new one.");
  }
}

function answerOf(station) {
  return { name_en: station.name_en, name_zh: station.name_zh, name_ta: station.name_ta, codes: station.codes };
}

// What a client may see. The station's name only appears once the round is
// over, and each hint only once its tier is bought.
export function view(round, station, now = Date.now()) {
  const name = station.name_en;
  const over = finished(round);
  const base = {
    round_id: round.id,
    length: letterPositions(name).length,
    line_color: colorsFor(station.lines)[0]?.hex ?? null,
    solved: round.solved,
    gave_up: round.gave_up,
    created_at: round.created_at,
  };

  if (legacy(round)) {
    return {
      ...base,
      mask: maskOf(name, round.revealed_positions, over),
      hint_tier: round.hint_tier,
      hints: hintsFor(station, round.hint_tier),
      score: round.score,
      expired: !over,
      next_reveal_in: null,
      next_hint: null,
      difficulty: "normal",
      turn_seconds: null,
      time_left: null,
      ...(over ? { answer: answerOf(station) } : {}),
    };
  }

  const { settings, limit, s } = stateOf(round, station, now);
  const elapsed = elapsedOf(round, now);
  const expired = !over && elapsed > limit;
  const live = !over && !expired;

  const out = {
    ...base,
    mask: maskOf(name, round.reveal_order.slice(0, s.revealed), over),
    hint_tier: s.tier,
    hints: hintsFor(station, s.tier),
    score: over ? s.points : s.base,
    expired,
    next_reveal_in: live ? nextRevealIn(name, settings.difficulty, elapsed, s.bought, limit) : null,
    next_hint: over ? null : nextHint(s.tier, s.revealed, name, settings.difficulty),
    difficulty: settings.difficulty,
    turn_seconds: settings.turn,
    time_left: settings.turn && !over ? Math.max(0, limit - elapsed) : null,
  };
  if (s.done?.by === "solved") {
    out.scoring = { base: s.base, ...multipliers(settings, s.done.t), points: s.points, time_ms: s.done.t };
  }
  if (over) out.answer = answerOf(station);
  return out;
}

// The round as a replay: the same format a party game uses, with one player
// and one turn. Built from the stored events, so its points are the server's.
export function soloReplay(round, station, name) {
  const settings = settingsOf(round);
  const { s, limit } = stateOf(round, station, Date.now());
  return {
    v: 1,
    kind: "solo",
    at: round.created_at,
    settings,
    players: [name],
    turns: [
      {
        station: station.name_en,
        order: round.reveal_order,
        end: s.done ? s.done.t : limit,
        events: [round.events ?? []],
      },
    ],
  };
}

export const replayable = (round) => finished(round) && !legacy(round);

const WRITABLE = ["hint_tier", "revealed_positions", "score", "solved", "gave_up", "finished_at", "letters_bought", "events"];

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
