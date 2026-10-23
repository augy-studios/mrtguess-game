// POST /api/round/hint  { round_id, client_key }
// -> { mask, hint_tier, score, penalty, bought_tier, ...view }
//
// bought_tier is the rung just bought. hint_tier stays at the last named hint
// when it is a letter.

import { clientKey, endpoint, roundId } from "../_lib/http.js";
import { applyHint, assertPlayable, updateRound, view } from "../_lib/game.js";

export default endpoint("POST", async ({ bot, body }) => {
  const id = roundId(body.round_id);
  const key = clientKey(body.client_key, bot);

  const { round, station, result } = await updateRound(id, key, (round, station) => {
    assertPlayable(round);
    return applyHint(round, station);
  });

  return { penalty: result.penalty, bought_tier: result.tier, ...view(round, station) };
});
