-- MRT Station Guesser schema, in the shared uwuapps Supabase project.
-- Paste into the Supabase SQL editor and run, then scripts/seed_supabase.py.
-- Safe to run again: everything is "if not exists" or "or replace".
--
-- Access model: only the Vercel functions and the seed script touch these
-- tables, with the service role key. There is no Supabase Auth and no
-- uwu_users here. RLS is on with no policies, so an anon key reads nothing.

-- Stations. Seeded from main-site/data/stations.geojson, one row per English
-- name, so an interchange is one answer with several codes.
create table if not exists mrtguessr_stations (
  id bigserial primary key,
  name_en text not null unique,
  name_zh text,
  name_ta text,
  codes text[] not null,          -- ['NS24','NE6','CC1']
  lines text[] not null,          -- ['NS','NE','CC'], see api/_lib/lines.js
  lat double precision,
  lon double precision
);

-- One round is one game. The answer is station_id, and it never leaves the
-- server until the round is over.
create table if not exists mrtguessr_rounds (
  id uuid primary key default gen_random_uuid(),
  station_id bigint references mrtguessr_stations(id),
  client_key text,
  hint_tier smallint not null default 0,
  revealed_positions smallint[] not null default '{}',
  score int not null default 1000,
  solved boolean not null default false,
  submitted boolean not null default false,
  created_at timestamptz not null default now(),
  -- Beyond the spec's columns. Letters come from the clock and from hints;
  -- this counts the bought ones, so the rest are the clock's.
  letters_bought smallint not null default 0,
  gave_up boolean not null default false,
  finished_at timestamptz,
  -- Bumped on every write. Updates are conditional on it, so two requests at
  -- once cannot both charge for the same letter.
  version int not null default 0
);

create index if not exists mrtguessr_rounds_created
  on mrtguessr_rounds (created_at);

create table if not exists mrtguessr_leaderboard (
  id bigserial primary key,
  name text not null,
  score int not null,
  round_id uuid not null unique references mrtguessr_rounds(id),
  created_at timestamptz not null default now()
);

create index if not exists mrtguessr_lb_best
  on mrtguessr_leaderboard (lower(name), score desc);

-- Each name's best score. The earliest of an equal top score wins, and the
-- casing shown is the one attached to that score.
create or replace view mrtguessr_leaderboard_best
with (security_invoker = true) as
select distinct on (lower(name)) name, score, created_at
from mrtguessr_leaderboard
order by lower(name), score desc, created_at asc;

-- Fixed window counters for rate limiting by IP. There are no accounts to
-- limit against, and Vercel functions share no memory.
create table if not exists mrtguessr_rate_limits (
  bucket text primary key,
  window_start timestamptz not null,
  hits int not null
);

alter table mrtguessr_stations enable row level security;
alter table mrtguessr_rounds enable row level security;
alter table mrtguessr_leaderboard enable row level security;
alter table mrtguessr_rate_limits enable row level security;

-- True while the bucket is under its limit. One statement, so concurrent
-- hits cannot both read the old count.
create or replace function mrtguessr_hit(p_bucket text, p_window_seconds int, p_max int)
returns boolean
language sql
volatile
as $$
  insert into mrtguessr_rate_limits as r (bucket, window_start, hits)
  values (p_bucket, now(), 1)
  on conflict (bucket) do update set
    window_start = case
      when r.window_start < now() - make_interval(secs => p_window_seconds) then now()
      else r.window_start end,
    hits = case
      when r.window_start < now() - make_interval(secs => p_window_seconds) then 1
      else r.hits + 1 end
  returning hits <= p_max;
$$;

-- Submits a solved round under a name the API has already validated. The
-- score is read from the round, never taken from the caller.
create or replace function mrtguessr_submit(p_round_id uuid, p_name text)
returns table (status text, best_score int, rank bigint)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_round mrtguessr_rounds%rowtype;
  v_best int;
  v_best_at timestamptz;
begin
  select * into v_round from mrtguessr_rounds where id = p_round_id for update;

  if not found then
    return query select 'not_found'::text, null::int, null::bigint;
    return;
  end if;
  if not v_round.solved then
    return query select 'unfinished'::text, null::int, null::bigint;
    return;
  end if;
  if v_round.submitted then
    return query select 'already_submitted'::text, null::int, null::bigint;
    return;
  end if;
  if v_round.created_at < now() - interval '1 hour' then
    return query select 'expired'::text, null::int, null::bigint;
    return;
  end if;

  update mrtguessr_rounds set submitted = true where id = p_round_id;
  insert into mrtguessr_leaderboard (name, score, round_id)
  values (p_name, v_round.score, p_round_id);

  select l.score, l.created_at into v_best, v_best_at
  from mrtguessr_leaderboard l
  where lower(l.name) = lower(p_name)
  order by l.score desc, l.created_at asc
  limit 1;

  return query
  select 'ok'::text, v_best, (
    select count(*) + 1
    from mrtguessr_leaderboard_best b
    where b.score > v_best or (b.score = v_best and b.created_at < v_best_at)
  );
end;
$$;

-- Housekeeping, called now and then by /api/round/new. Old counters, and
-- rounds nobody submitted that are past any use.
create or replace function mrtguessr_prune()
returns void
language sql
volatile
as $$
  delete from mrtguessr_rate_limits where window_start < now() - interval '1 day';
  delete from mrtguessr_rounds r
  where r.created_at < now() - interval '2 days'
    and not r.submitted
    and not exists (select 1 from mrtguessr_leaderboard l where l.round_id = r.id);
$$;

-- Service role only.
revoke all on function mrtguessr_hit(text, int, int) from public, anon, authenticated;
revoke all on function mrtguessr_submit(uuid, text) from public, anon, authenticated;
revoke all on function mrtguessr_prune() from public, anon, authenticated;
grant execute on function mrtguessr_hit(text, int, int) to service_role;
grant execute on function mrtguessr_submit(uuid, text) to service_role;
grant execute on function mrtguessr_prune() to service_role;
