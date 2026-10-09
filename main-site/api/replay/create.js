// POST /api/replay/create -> { id }
//
//   { round_id, client_key, name? }   a finished solo round, built here from
//                                     the stored events: verified
//   { replay }                        a party game, sent by the host's page
//                                     in js/replay-format.js's format: not
//                                     verified, since only the host saw it
//
// The page links to /r/<id>. A solo round has one replay; asking again
// returns the same id. Party replays are cleaned, names and guesses run
// through the leaderboard's word filter, and stored as they are.

import { randomInt } from "node:crypto";
import { clientKey, endpoint, HttpError, roundId } from "../_lib/http.js";
import { loadRound, replayable, soloReplay, stationById } from "../_lib/game.js";
import { cleanName, profane } from "../_lib/names.js";
import { rest } from "../_lib/supabase.js";
import { cleanReplay } from "../../js/replay-format.js";

const ID_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
const ID_LENGTH = 8;
const MAX_BYTES = 256 * 1024;

const newId = () => Array.from({ length: ID_LENGTH }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join("");

function nameOrNull(value) {
  try {
    return cleanName(value);
  } catch {
    return null;
  }
}

async function store(row) {
  const body = JSON.stringify(row.body);
  if (new TextEncoder().encode(body).length > MAX_BYTES) {
    throw new HttpError(413, "too_big", "That game is too long to store. Share the long link instead.");
  }
  // Eight characters from 55 make a clash vanishingly rare, but a second try
  // costs nothing.
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newId();
    try {
      await rest("mrtguessr_replays", { method: "POST", body: { id, ...row } });
      return id;
    } catch (err) {
      if (!/supabase 409/.test(err.message)) throw err;
    }
  }
  throw new HttpError(503, "busy", "Could not store the replay. Try again.");
}

async function solo(body, bot) {
  const id = roundId(body.round_id);
  const round = await loadRound(id, clientKey(body.client_key, bot));
  if (!replayable(round)) throw new HttpError(409, "not_finished", "Only a finished round can be replayed.");

  const [existing] = (await rest(`mrtguessr_replays?round_id=eq.${id}&select=id`)) ?? [];
  if (existing) return { id: existing.id };

  const station = await stationById(round.station_id);
  const replay = cleanReplay(soloReplay(round, station, nameOrNull(body.name) ?? "Player"));
  try {
    return { id: await store({ kind: "solo", verified: true, round_id: id, body: replay }) };
  } catch (err) {
    // Asked twice at once: the other request stored it first.
    if (!/supabase 409/.test(err.message ?? "")) throw err;
    const [row] = (await rest(`mrtguessr_replays?round_id=eq.${id}&select=id`)) ?? [];
    if (!row) throw err;
    return { id: row.id };
  }
}

async function party(body) {
  const replay = cleanReplay(body.replay);
  if (!replay || replay.kind !== "party") throw new HttpError(400, "bad_replay", "That is not a replay.");
  replay.players = replay.players.map((p, i) => nameOrNull(p) ?? `Player ${i + 1}`);
  for (const turn of replay.turns) {
    for (const events of turn.events) {
      for (const e of events ?? []) if (e[1] === "g" && profane(e[2])) e[2] = "(hidden)";
    }
  }
  return { id: await store({ kind: "party", verified: false, body: replay }) };
}

export default endpoint("POST", async ({ bot, body }) => (body.replay ? party(body) : solo(body, bot)));
