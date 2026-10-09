-- Difficulty and time limits, rounds kept as events, and shareable replays.
-- Run after 005, before deploying the code that uses them. Safe to run again.
--
-- A round now records what the player did as events and the order its
-- letters show in, and the API works the score out from those with
-- main-site/js/rules.js. score, solved and finished_at are still written, so
-- mrtguessr_submit and both boards read them as before; a solved round's
-- score now includes its difficulty, time limit and speed multipliers.
--
-- Rounds started before this have no reveal_order. The API treats them as
-- expired: they can be given up, to see the answer, but not played on.

alter table mrtguessr_rounds
  add column if not exists difficulty text not null default 'normal'
    check (difficulty in ('easy', 'normal', 'hard')),
  -- Seconds, or null for no limit (the bots, and solo's default).
  add column if not exists turn_seconds smallint
    check (turn_seconds in (30, 60, 120)),
  add column if not exists reveal_order smallint[],
  -- [[ms since created_at, kind, data], ...]; see main-site/js/rules.js.
  add column if not exists events jsonb not null default '[]'::jsonb;

-- Replays behind the short /r/<id> links. A solo replay is built by the API
-- from the round and is verified; a party replay is sent by the host's page
-- and is not. The body is the whole replay, so it outlives the round, which
-- mrtguessr_prune may delete.
create table if not exists mrtguessr_replays (
  id text primary key check (id ~ '^[A-Za-z0-9]{8}$'),
  kind text not null check (kind in ('solo', 'party')),
  verified boolean not null default false,
  round_id uuid unique references mrtguessr_rounds(id) on delete set null,
  body jsonb not null check (octet_length(body::text) <= 262144),
  created_at timestamptz not null default now()
);

alter table mrtguessr_replays enable row level security;
