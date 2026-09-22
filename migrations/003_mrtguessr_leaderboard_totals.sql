-- The cumulative leaderboard: every submitted round's score added up per name.
-- Run after 001 and 002. Safe to run again.

-- One row per name (case-insensitive). The casing shown is the name's most
-- recent submission. Ranked by total; ties go to fewer rounds, then to
-- whoever reached it first, which is the earlier last_at.
create or replace view mrtguessr_leaderboard_total
with (security_invoker = true) as
select
  (array_agg(name order by created_at desc))[1] as name,
  sum(score)::bigint as total,
  count(*)::int as rounds,
  max(score) as best,
  max(created_at) as last_at
from mrtguessr_leaderboard
group by lower(name);

-- submit now also returns the name's total and its place on that board. The
-- return type changes, which "create or replace" cannot do, hence the drop.
drop function if exists mrtguessr_submit(uuid, text);

create function mrtguessr_submit(p_round_id uuid, p_name text)
returns table (status text, best_score int, rank bigint, total bigint, rounds int, total_rank bigint)
language plpgsql
volatile
as $$
#variable_conflict use_column
declare
  v_round mrtguessr_rounds%rowtype;
  v_best int;
  v_best_at timestamptz;
  v_total bigint;
  v_rounds int;
begin
  select * into v_round from mrtguessr_rounds where id = p_round_id for update;

  if not found then
    return query select 'not_found'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if not v_round.solved then
    return query select 'unfinished'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_round.submitted then
    return query select 'already_submitted'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;
  if v_round.created_at < now() - interval '1 hour' then
    return query select 'expired'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
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

  select sum(l.score)::bigint, count(*)::int into v_total, v_rounds
  from mrtguessr_leaderboard l
  where lower(l.name) = lower(p_name);

  return query
  select
    'ok'::text,
    v_best,
    (
      select count(*) + 1
      from mrtguessr_leaderboard_best b
      where b.score > v_best or (b.score = v_best and b.created_at < v_best_at)
    ),
    v_total,
    v_rounds,
    (
      select count(*) + 1
      from mrtguessr_leaderboard_total t
      where lower(t.name) <> lower(p_name)
        and (
          t.total > v_total
          or (t.total = v_total and t.rounds < v_rounds)
          -- This name's total was only just reached, so an equal one got there first.
          or (t.total = v_total and t.rounds = v_rounds)
        )
    );
end;
$$;

revoke all on function mrtguessr_submit(uuid, text) from public, anon, authenticated;
grant execute on function mrtguessr_submit(uuid, text) to service_role;
