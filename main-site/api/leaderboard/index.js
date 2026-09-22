// GET /api/leaderboard -> { entries: [{ rank, name, score }] }
// Public, no login. Each name's best score only, cached briefly at the edge.

import { endpoint } from "../_lib/http.js";
import { rest } from "../_lib/supabase.js";

const LIMIT = 100;

export default endpoint("GET", async ({ res }) => {
  const rows = await rest(
    `mrtguessr_leaderboard_best?select=name,score&order=score.desc,created_at.asc&limit=${LIMIT}`
  );
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=30, stale-while-revalidate=60");
  return { entries: (rows ?? []).map((r, i) => ({ rank: i + 1, name: r.name, score: r.score })) };
});
