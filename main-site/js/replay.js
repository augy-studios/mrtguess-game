// Shareable replays: making the link, and playing one back.
//
// A link is short when the API can store the replay (/r/<id>). When it
// cannot, offline or refused, a party game's link carries the whole replay
// instead (/?replay=...), the way chess-game's links do. Opening either plays
// the game back on its own card, station by station, with every score worked
// out again from the events by js/rules.js.

import { api } from "./api.js";
import { cleanReplay, packReplay, unpackReplay } from "./replay-format.js";
import {
  HINT_LABELS,
  describeTurn,
  difficultyOf,
  gameScore,
  hintsFor,
  isCorrect,
  lengthMultiplier,
  maskOf,
  turnState,
} from "./rules.js";
import { loadStations } from "./stations.js";
import { altNames, clock, codeChips, hintRows, laterHintRows, maskMarkup, stationCount } from "./round-view.js";
import { currentView, escapeHtml, hydrateIcons, showView } from "./ui.js";

const SPEEDS = [1, 2, 4, 8];
// How long a finished station's answer stays up before the next one plays.
const BETWEEN_MS = 3000;

const $ = (id) => document.getElementById(id);

/* ---- making links ---- */

export const shortLink = (id) => `${location.origin}/r/${id}`;

// Through the share sheet where there is one, the clipboard otherwise.
export async function shareLink(url, title = "MRT Station Guesser replay") {
  if (navigator.share) {
    try {
      await navigator.share({ title, url });
      return "shared";
    } catch (err) {
      if (err?.name === "AbortError") return "cancelled";
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

// A solo round's replay is built by the API from the stored round, so it
// needs the API: solo rounds do anyway.
export async function soloReplayLink(roundId, name) {
  const { id } = await api.soloReplay(roundId, name);
  return shortLink(id);
}

export async function partyReplayLink(replay) {
  try {
    const { id } = await api.partyReplay(replay);
    return shortLink(id);
  } catch {
    return `${location.origin}/?replay=${await packReplay(replay)}`;
  }
}

// The replay a page address asks for, if any.
export function replayFromLocation() {
  const short = location.pathname.match(/^\/r\/([A-Za-z0-9]{8})\/?$/);
  if (short) return { id: short[1] };
  const packed = new URLSearchParams(location.search).get("replay");
  return packed ? { packed } : null;
}

/* ---- playing one back ---- */

let rp = null; // { replay, verified, link, stations }
let turnIndex = 0;
let t = 0;
let playing = false;
let speed = 1;
let selected = 0;
let frame = null;
let lastNow = 0;
let nextTimer = null;
let returnTo = "solo";
const drawn = {};

const turn = () => rp.replay.turns[turnIndex];
const settings = () => rp.replay.settings;

function statesAt(at) {
  const tn = turn();
  return rp.replay.players.map((_, i) =>
    tn.events[i] ? turnState(tn.station, settings(), tn.events[i], tn.end, at) : null
  );
}

function once(key, value, draw) {
  if (drawn[key] === value) return;
  drawn[key] = value;
  draw();
}

function showPanel(id) {
  for (const p of ["rvLoading", "rvBody"]) $(p).classList.toggle("hidden", p !== id);
}

export async function openReplay(source) {
  if (currentView() !== "replay") returnTo = currentView();
  stop();
  rp = null;
  showView("replay");
  $("rvMeta").textContent = "";
  $("rvTrust").textContent = "";
  $("rvLoadingText").textContent = "Loading the replay.";
  showPanel("rvLoading");

  try {
    let replay;
    let verified = false;
    let link;
    if (source.id) {
      const r = await api.replay(source.id);
      replay = cleanReplay(r.replay);
      verified = r.verified === true;
      link = shortLink(r.id);
    } else {
      replay = source.replay ?? (await unpackReplay(source.packed));
      link = "link" in source ? source.link : `${location.origin}/?replay=${source.packed}`;
    }
    if (!replay) throw Object.assign(new Error("bad"), { code: "bad_replay" });

    const stations = await loadStations().catch(() => null);
    rp = { replay, verified, link, stations: stations?.byName ?? new Map() };
  } catch (err) {
    $("rvLoadingText").textContent =
      err.code === "offline"
        ? "Opening this replay needs a connection."
        : err.status === 404
          ? "There is no replay at that link."
          : err.code === "bad_replay"
            ? "That replay link is damaged or incomplete."
            : "The replay did not load. Try again in a moment.";
    return;
  }

  for (const key of Object.keys(drawn)) delete drawn[key];
  drawHeader();
  drawStandings();
  showPanel("rvBody");
  goTo(0, { autoplay: true });
}

function close() {
  stop();
  rp = null;
  if (replayFromLocation()) history.replaceState(null, "", "/");
  showView(returnTo === "replay" ? "solo" : returnTo);
}

function drawHeader() {
  const r = rp.replay;
  const party = r.kind === "party";
  const count = r.turns.length;
  const bits = [
    party ? `Party game, ${r.players.length} players` : `Solo round, ${escapeHtml(r.players[0])}`,
    difficultyOf(r.settings.difficulty).label,
    r.settings.turn ? `${describeTurn(r.settings.turn)} per station` : "No time limit",
  ];
  if (party) bits.push(stationCount(count));
  if (r.at) bits.push(new Date(r.at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }));
  $("rvMeta").innerHTML = bits.join(" · ");
  $("rvTrust").textContent = rp.verified
    ? "Checked by the server: these are the moves as it recorded them."
    : "Recorded by the host's device. Party games are not checked and never go on the leaderboard.";
}

function goTo(index, { autoplay = false } = {}) {
  stop();
  turnIndex = Math.max(0, Math.min(rp.replay.turns.length - 1, index));
  t = 0;
  // Somebody not in this station: follow the first player who is.
  if (!turn().events[selected]) selected = Math.max(0, turn().events.findIndex(Boolean));
  const tn = turn();
  $("rvScrub").max = String(tn.end);
  $("rvTurn").textContent = `Station ${turnIndex + 1} of ${rp.replay.turns.length}`;
  $("rvPrev").disabled = turnIndex === 0;
  $("rvNext").disabled = turnIndex === rp.replay.turns.length - 1;
  draw();
  if (autoplay) play();
}

function draw() {
  const tn = turn();
  const ended = t >= tn.end;
  const states = statesAt(t);
  const mine = states[selected];
  const row = rp.stations.get(tn.station.toLowerCase());

  // The selected player's letters; the whole name once the station is over.
  const mask = maskOf(tn.station, tn.order.slice(0, mine?.revealed ?? 0), ended);
  once("mask", `${turnIndex}|${mask}`, () => {
    const { html, label } = maskMarkup(mask, drawn.prevMask?.turn === turnIndex ? drawn.prevMask.mask : "");
    $("rvMask").innerHTML = html;
    $("rvMask").setAttribute("aria-label", label);
    drawn.prevMask = { turn: turnIndex, mask };
  });

  // Hints are the selected player's. The map is left out of a replay; the
  // row says it was bought.
  const tier = mine?.tier ?? 1;
  once("hints", `${turnIndex}|${tier}|${Boolean(row)}`, () => {
    if (!row) {
      $("rvHints").innerHTML = "";
      return;
    }
    const h = hintsFor(row, tier);
    $("rvHints").innerHTML =
      hintRows(h) +
      (h.position ? `<div class="hint-row"><dt>Map</dt><dd>Bought</dd></div>` : "") +
      laterHintRows(h);
  });

  once("answer", `${turnIndex}|${ended}`, () => {
    $("rvAnswer").classList.toggle("hidden", !ended);
    if (!ended) return;
    $("rvAnswerName").textContent = tn.station;
    $("rvAlt").innerHTML = row ? altNames(row) : "";
    $("rvCodes").innerHTML = row ? codeChips(row.codes) : "";
  });

  $("rvTime").textContent = `${clock(t)} / ${clock(tn.end)}`;
  if (document.activeElement !== $("rvScrub")) $("rvScrub").value = String(Math.round(t));

  const rows = rp.replay.players.map((name, i) => [name, i, states[i] ? describe(states[i], ended) : "Not playing"]);
  once("players", JSON.stringify([turnIndex, selected, rows]), () => {
    $("rvPlayers").innerHTML = rows
      .map(
        ([name, i, text]) =>
          `<li><button type="button" class="player-pick${i === selected ? " active" : ""}" data-player="${i}" aria-pressed="${i === selected}">` +
          `<span class="player-name">${escapeHtml(name)}</span><span class="player-state">${escapeHtml(text)}</span></button></li>`
      )
      .join("");
  });

  const log = logLines(states, ended);
  once("log", JSON.stringify([turnIndex, log]), () => {
    $("rvLog").innerHTML = log.length
      ? log.map(([at, text]) => `<li><span class="log-time">${clock(at)}</span>${escapeHtml(text)}</li>`).join("")
      : `<li class="log-empty">Nothing yet.</li>`;
  });
}

function describe(s, ended) {
  if (s.done?.by === "solved") return `Got it at ${clock(s.done.t)}, ${s.points} points`;
  if (s.done?.by === "gave_up") return `Gave up at ${clock(s.done.t)}`;
  if (ended) return "Out of time";
  return `Guessing, ${s.base} so far`;
}

// Everything everybody did up to now, newest first. A right guess does not
// say the name until the station is over, so a viewer can guess along.
function logLines(states, ended) {
  const lines = [];
  states.forEach((s, i) => {
    if (!s) return;
    const who = rp.replay.players[i];
    for (const [at, kind, data] of s.events) {
      let text;
      if (kind === "h") text = data === 5 ? `${who} bought a letter` : `${who} bought the ${HINT_LABELS[data].toLowerCase()} hint`;
      else if (kind === "x") text = `${who} gave up`;
      else if (isCorrect(data, turn().station)) text = ended ? `${who} got it: ${data}` : `${who} got it`;
      else text = `${who} guessed ${data}`;
      lines.push([at, text]);
    }
  });
  return lines.sort((a, b) => b[0] - a[0]).slice(0, 40);
}

// Totals over the whole game, and a party game's score with its length
// multiplier.
function drawStandings() {
  const r = rp.replay;
  const rows = r.players.map((name, i) => {
    let total = 0;
    let solved = 0;
    r.turns.forEach((tn) => {
      if (!tn.events[i]) return;
      const s = turnState(tn.station, r.settings, tn.events[i], tn.end, tn.end);
      total += s.points;
      if (s.done?.by === "solved") solved += 1;
    });
    return { name, total, solved, game: gameScore(total, r.turns.length) };
  });
  rows.sort((a, b) => b.total - a.total || b.solved - a.solved);

  if (r.kind === "solo") {
    const only = rows[0];
    $("rvStandingsTitle").textContent = only.solved ? `Solved for ${only.total} points` : "Not solved";
    $("rvTable").innerHTML = "";
    $("rvGameNote").textContent = "";
    return;
  }
  const mult = lengthMultiplier(r.turns.length);
  $("rvStandingsTitle").textContent = "Final standings";
  $("rvTable").innerHTML =
    `<thead><tr><th>#</th><th>Player</th><th>Solved</th><th>Points</th><th>Game score</th></tr></thead><tbody>` +
    rows
      .map((p, i) => {
        const rank = i > 0 && rows[i - 1].total === p.total ? "=" : String(i + 1);
        return `<tr><td>${rank}</td><td>${escapeHtml(p.name)}</td><td>${p.solved}</td><td>${p.total}</td><td>${p.game}</td></tr>`;
      })
      .join("") +
    `</tbody>`;
  $("rvGameNote").textContent = `Game score is points × ${mult} for ${stationCount(r.turns.length)}.`;
}

/* ---- the transport ---- */

function frameTick(now) {
  frame = null;
  if (!playing || !rp) return;
  t = Math.min(turn().end, t + (now - lastNow) * speed);
  lastNow = now;
  draw();
  if (t >= turn().end) {
    pause();
    // The answer stays up a moment, then the next station plays.
    if (turnIndex < rp.replay.turns.length - 1) {
      nextTimer = setTimeout(() => goTo(turnIndex + 1, { autoplay: true }), BETWEEN_MS);
    }
    return;
  }
  frame = requestAnimationFrame(frameTick);
}

function play() {
  if (!rp) return;
  clearTimeout(nextTimer);
  if (t >= turn().end) t = 0;
  playing = true;
  lastNow = performance.now();
  syncPlay();
  frame ??= requestAnimationFrame(frameTick);
}

function pause() {
  playing = false;
  if (frame) cancelAnimationFrame(frame);
  frame = null;
  syncPlay();
}

function stop() {
  pause();
  clearTimeout(nextTimer);
}

function syncPlay() {
  const btn = $("rvPlay");
  btn.setAttribute("aria-label", playing ? "Pause" : "Play");
  btn.querySelector("[data-icon]").setAttribute("data-icon", playing ? "pause" : "play");
  hydrateIcons(btn);
}

function syncSpeed() {
  document.querySelectorAll("#rvSpeed [data-speed]").forEach((el) => {
    const on = Number(el.dataset.speed) === speed;
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", String(on));
  });
}

export function initReplay() {
  $("rvClose").addEventListener("click", close);
  $("rvLoadingBack").addEventListener("click", close);
  $("rvPlay").addEventListener("click", () => (playing ? pause() : play()));
  $("rvPrev").addEventListener("click", () => goTo(turnIndex - 1));
  $("rvNext").addEventListener("click", () => goTo(turnIndex + 1));
  $("rvScrub").addEventListener("input", (e) => {
    stop();
    t = Number(e.target.value);
    draw();
  });
  $("rvSpeed").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-speed]");
    if (!btn || !SPEEDS.includes(Number(btn.dataset.speed))) return;
    speed = Number(btn.dataset.speed);
    syncSpeed();
  });
  $("rvPlayers").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-player]");
    if (!btn || !rp) return;
    selected = Number(btn.dataset.player);
    draw();
  });
  $("rvShare").addEventListener("click", async () => {
    if (!rp) return;
    if (!rp.link) {
      $("rvShareMsg").textContent = "Close the replay and use Share replay to make a link.";
      return;
    }
    const how = await shareLink(rp.link);
    $("rvShareMsg").textContent = how === "copied" ? "Link copied." : how === "failed" ? rp.link : "";
  });
  syncSpeed();

  // A replay link opened in this tab: the page shows nothing else first.
  const source = replayFromLocation();
  if (source) {
    returnTo = "solo";
    openReplay(source);
    return true;
  }
  return false;
}
