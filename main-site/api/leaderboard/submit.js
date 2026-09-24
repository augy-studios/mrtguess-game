// POST /api/leaderboard/submit  { round_id, name }
//   -> { name, rank, best_score, total, rounds, total_rank }
// rank and best_score are the best-score board; total, rounds and total_rank
// are the cumulative one. The score is read from the round, never taken from
// the request.

import { endpoint, HttpError, roundId } from "../_lib/http.js";
import { cleanName } from "../_lib/names.js";
import { rpc } from "../_lib/supabase.js";

const REFUSALS = {
  not_found: [404, "That round does not exist."],
  unfinished: [409, "Only a solved round can go on the leaderboard."],
  already_submitted: [409, "That round is already on the leaderboard."],
  expired: [410, "That round is more than an hour old."],
  // Anti-cheat, see migrations/004. The round still counts as solved; it just
  // stays off the boards.
  too_fast: [409, "That round was solved too quickly to count. Rounds solved in under 3 seconds stay off the leaderboard."],
  overlap: [409, "That round was played at the same time as another round already on the leaderboard under this name."],
};

export default endpoint("POST", async ({ body }) => {
  const id = roundId(body.round_id);
  const name = cleanName(body.name);

  const [row] = (await rpc("mrtguessr_submit", { p_round_id: id, p_name: name })) ?? [];
  if (row?.status !== "ok") {
    const [status, message] = REFUSALS[row?.status] ?? [500, "Could not submit."];
    throw new HttpError(status, row?.status ?? "server", message);
  }

  return {
    name,
    rank: Number(row.rank),
    best_score: row.best_score,
    total: Number(row.total),
    rounds: row.rounds,
    total_rank: Number(row.total_rank),
  };
});
