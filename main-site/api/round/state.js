// POST /api/round/state  { round_id, client_key }
// The round as it stands, with any clock reveals that have come due. Clients
// call it at next_reveal_in to show letters appearing.

import { clientKey, endpoint, roundId } from "../_lib/http.js";
import { applyClock, updateRound, view } from "../_lib/game.js";

export default endpoint("POST", async ({ bot, body }) => {
  const id = roundId(body.round_id);
  const key = clientKey(body.client_key, bot);

  const { round, station } = await updateRound(id, key, (round, station) =>
    applyClock(round, station) ? {} : { write: false }
  );

  return view(round, station);
});
