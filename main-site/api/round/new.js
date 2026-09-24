// POST /api/round/new  { client_key }
// Starts a round. The answer stays in mrtguessr_rounds; the reply carries
// only the mask and the free first hint.

import { randomInt } from "node:crypto";
import { clientKey, endpoint } from "../_lib/http.js";
import { pickStation, START_SCORE, view } from "../_lib/game.js";
import { rest, rpc } from "../_lib/supabase.js";

export default endpoint("POST", async ({ bot, body }) => {
  const key = clientKey(body.client_key, bot);
  const station = await pickStation(key);

  const [round] = await rest("mrtguessr_rounds", {
    method: "POST",
    body: { station_id: station.id, client_key: key, hint_tier: 1, score: START_SCORE },
    prefer: "return=representation",
  });

  // Now and then, clear out abandoned rounds.
  if (randomInt(50) === 0) rpc("mrtguessr_prune", {}).catch((err) => console.warn("prune failed:", err.message));

  return view(round, station);
});
