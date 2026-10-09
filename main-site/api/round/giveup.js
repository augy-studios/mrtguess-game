// POST /api/round/giveup  { round_id, client_key }
// Ends the round with no score. The reply names the station, which is safe
// now that nothing can be guessed. A round that ran out of time is ended the
// same way, to learn the answer.

import { clientKey, endpoint, roundId } from "../_lib/http.js";
import { applyGiveUp, assertPlayable, updateRound, view } from "../_lib/game.js";

export default endpoint("POST", async ({ bot, body }) => {
  const id = roundId(body.round_id);
  const key = clientKey(body.client_key, bot);

  const { round, station } = await updateRound(id, key, (round, station) => {
    // An expired round can still be given up, to learn the answer.
    if (round.solved || round.gave_up) assertPlayable(round);
    applyGiveUp(round, station);
  });

  return view(round, station);
});
