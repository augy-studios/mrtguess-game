-- The Tamil name hint, tier 5, with a letter moving from tier 5 to 6.
-- Run after 006, before deploying the code that uses it. Safe to run again.
--
-- A round's events say which tier each hint bought, so the API needs to know
-- which numbering they use. Every round already stored is version 1, with
-- letters at tier 5; the API writes 2 on new rounds, and moves an old round's
-- letters to 6 the next time it writes that round. Points come out the same
-- either way, so scores and both boards are unchanged.

alter table mrtguessr_rounds
  add column if not exists rules_version smallint not null default 1;
