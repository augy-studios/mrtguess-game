# migrations

SQL for the shared uwuapps Supabase project. Paste each file into the SQL
editor and run it, in number order. Each is safe to run again.

| File | What it does |
|---|---|
| `001_mrtguessr_schema.sql` | The `mrtguessr_` tables, the best-per-name leaderboard view, and the rate limit, submit and prune functions. |

After `001`, load the stations with `scripts/seed_supabase.py`.

Every table has row level security on with no policies. Only the service role
key, used by the Vercel functions and the seed script, can read or write.
