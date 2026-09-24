// POST /api/round/hint  { round_id, client_key }
// -> { mask, hint_tier, score, penalty, ...view }

import { clientKey, endpoint, roundId } from "../_lib/http.js";
import { applyClock, applyHint, assertPlayable, updateRound, view } from "../_lib/game.js";

export default endpoint("POST", async ({ bot, body }) => {
  const id = roundId(body.round_id);
  const key = clientKey(body.client_key, bot);

  const { round, station, result } = await updateRound(id, key, (round, station) => {
    assertPlayable(round);
    applyClock(round, station);
    return { penalty: applyHint(round, station) };
  });

  return { penalty: result.penalty, ...view(round, station) };
});
