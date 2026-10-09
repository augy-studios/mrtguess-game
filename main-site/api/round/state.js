// POST /api/round/state  { round_id, client_key }
// The round as it stands, with any letters the clock has shown. Clients call
// it at next_reveal_in to show letters appearing. Nothing is written: the
// letters showing are worked out from the time.

import { clientKey, endpoint, roundId } from "../_lib/http.js";
import { loadRound, stationById, view } from "../_lib/game.js";

export default endpoint("POST", async ({ bot, body }) => {
  const round = await loadRound(roundId(body.round_id), clientKey(body.client_key, bot));
  return view(round, await stationById(round.station_id));
});
