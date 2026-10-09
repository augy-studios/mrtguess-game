// POST /api/round/guess  { round_id, client_key, guess }
// -> { correct, mask, score, solved, ...view }

import { clientKey, endpoint, HttpError, roundId } from "../_lib/http.js";
import { applyGuess, assertPlayable, updateRound, view } from "../_lib/game.js";

export default endpoint("POST", async ({ bot, body }) => {
  const id = roundId(body.round_id);
  const key = clientKey(body.client_key, bot);
  const guess = typeof body.guess === "string" ? body.guess.trim().slice(0, 64) : "";
  if (!guess) throw new HttpError(400, "empty_guess");

  const { round, station, result } = await updateRound(id, key, (round, station) => {
    assertPlayable(round);
    return { correct: applyGuess(round, station, guess) };
  });

  return { correct: result.correct, ...view(round, station) };
});
