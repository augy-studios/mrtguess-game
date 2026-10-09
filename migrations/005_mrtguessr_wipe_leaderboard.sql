-- Wipes the leaderboard: every entry, so both boards (best score and total
-- points) start empty. Run after 004.
--
-- NOT safe to run again later: a second run wipes whatever has been added
-- since. On a fresh project it empties an empty table and does nothing.
--
-- Rounds are kept. They hold the recent stations each player is not given
-- again, and mrtguessr_prune clears old ones as before. A round already on
-- the board stays marked submitted, so it cannot be added a second time; it
-- is over an hour old by now or soon will be, past the point it could be
-- submitted anyway.

truncate table mrtguessr_leaderboard;
