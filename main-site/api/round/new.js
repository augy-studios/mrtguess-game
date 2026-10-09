// POST /api/round/new  { client_key, difficulty?, turn_seconds? }
// Starts a round. The answer stays in mrtguessr_rounds; the reply carries
// only the mask and the free first hint. difficulty is easy, normal or hard,
// turn_seconds 30, 60 or 120; leave either out for normal with no limit.

import { randomInt } from "node:crypto";
import { clientKey, endpoint } from "../_lib/http.js";
import { newRoundRow, pickStation, view } from "../_lib/game.js";
import { rest, rpc } from "../_lib/supabase.js";

export default endpoint("POST", async ({ bot, body }) => {
  const key = clientKey(body.client_key, bot);
  const station = await pickStation(key);

  const [round] = await rest("mrtguessr_rounds", {
    method: "POST",
    body: newRoundRow(station, key, body),
    prefer: "return=representation",
  });

  // Now and then, clear out abandoned rounds.
  if (randomInt(50) === 0) rpc("mrtguessr_prune", {}).catch((err) => console.warn("prune failed:", err.message));

  return view(round, station);
});
