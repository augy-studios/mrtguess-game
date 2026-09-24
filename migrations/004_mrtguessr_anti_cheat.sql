-- Simple anti-cheat at submission. Run after 003. Safe to run again.
--
-- The answer and the score already stay on the server, so what is left to
-- stop is a script playing the game: matching the mask against the public
-- station list and guessing at once, or farming the total board with many
-- rounds side by side. Two refusals, both only at the leaderboard; the round
-- itself plays and scores as before.
--
--   too_fast  solved within 3 seconds of the round starting, quicker than a
--             person can read the mask and type a name
--   overlap   played while another round already on the board under the
--             same name was also being played; a person plays one at a time

create or replace function mrtguessr_submit(p_round_id uuid, p_name text)
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
  if v_round.finished_at < v_round.created_at + interval '3 seconds' then
    return query select 'too_fast'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
    return;
  end if;

  -- One submission per name at a time, so two rounds sent together cannot
  -- both miss each other in the overlap check below.
  perform pg_advisory_xact_lock(hashtext('mrtguessr_submit:' || lower(p_name)));

  if exists (
    select 1
    from mrtguessr_leaderboard l
    join mrtguessr_rounds r on r.id = l.round_id
    where lower(l.name) = lower(p_name)
      and r.created_at < v_round.finished_at
      and r.finished_at > v_round.created_at
  ) then
    return query select 'overlap'::text, null::int, null::bigint, null::bigint, null::int, null::bigint;
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
