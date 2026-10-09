// Party games: up to eight people on one network, one station at a time,
// everybody on their own device.
//
// One device hosts: party-host.js runs the game there. The rest join with
// its code over a direct link (p2p.js, from STUN-p2p-spec.md). Both kinds of
// device draw the same snapshot with the code below; the host draws its own,
// and guests draw what the host sends them twenty times a second. Nothing a
// guest does shows as done until a snapshot says so.

import { Guest, normaliseCode, isValidCode, CODE_LENGTH } from "./p2p.js";
import { HOST_PID, LENGTHS, MAX_PLAYERS, PARTY_TURNS, PartyHost, cleanSeatName, savedRoom } from "./party-host.js";
import { DIFFICULTIES, HINT_LABELS, TURN_LIMITS, describeTurn, difficultyOf, lengthMultiplier } from "./rules.js";
import { loadStations } from "./stations.js";
import { qrToSvg } from "./qr.js";
import { altNames, breakdown, clock, codeChips, hintRows, laterHintRows, maskMarkup, stationCount } from "./round-view.js";
import { clearStation, showStation } from "./map.js";
import { applyMapStyle, getSettings } from "./settings.js";
import { openReplay, partyReplayLink, shareLink } from "./replay.js";
import { currentView, escapeHtml, hydrateIcons, showView } from "./ui.js";

const PANELS = ["partyStart", "partyNotice", "partyLobby", "partyReady", "partyPlay", "partyResult", "partyFinal"];
const NAME_KEY = "mrtguessr.party.name";
const PID_KEY = "mrtguessr.party.pid";
const LAST_CODE_KEY = "mrtguessr.party.lastCode";
// In session storage: this tab was in a game as a guest, so a reload rejoins.
const GUEST_KEY = "mrtguessr.party.guest";
// After a dropped link: wait this long, then try again, this many times.
const RETRY_MS = 2000;
const RETRIES = 4;
// Nothing from the host for this long reads as a stale link.
const STALE_MS = 2000;

const $ = (id) => document.getElementById(id);

const store = (kind) => ({
  get(key) {
    try {
      return window[kind].getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      if (value == null) window[kind].removeItem(key);
      else window[kind].setItem(key, value);
    } catch {
      // Blocked storage: nothing remembered, nothing broken.
    }
  },
});
const local = store("localStorage");
const session = store("sessionStorage");

let role = null; // null, "host" or "guest"
let room = null; // PartyHost, hosting
let guest = null; // Guest, joining
let code = ""; // the code a guest is on
let snap = null;
let lastHeard = 0;
let retries = 0;
let retryTimer = null;
let customLength = false;
let shownMask = "";
let wakeLock = null;
const drawn = {};
let armed = { hint: null, giveUp: null, leave: null };

/* ---- small things ---- */

function once(key, value, draw) {
  if (drawn[key] === value) return;
  drawn[key] = value;
  draw();
}

function resetDrawn() {
  for (const key of Object.keys(drawn)) delete drawn[key];
  shownMask = "";
}

function showPanel(id) {
  for (const p of PANELS) {
    const el = $(p);
    const on = p === id;
    if (el.classList.contains("hidden") === on) el.classList.toggle("hidden", !on);
  }
}

function playerId() {
  let pid = local.get(PID_KEY);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(pid ?? "")) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    pid = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    local.set(PID_KEY, pid);
  }
  return pid;
}

function savedName() {
  return cleanSeatName(local.get(NAME_KEY) ?? "") || getSettings().name || "";
}

// The name in the start panel, saved for next time, or null with a nudge.
function takeName() {
  const name = cleanSeatName($("partyName").value);
  if (!name) {
    startMsg("Enter your name first.");
    $("partyName").focus();
    return null;
  }
  local.set(NAME_KEY, name);
  return name;
}

function startMsg(text) {
  $("partyStartMsg").textContent = text;
}

async function keepAwake(on) {
  if (!on) {
    const lock = wakeLock;
    wakeLock = null;
    lock?.release?.().catch(() => {});
    return;
  }
  if (wakeLock || !("wakeLock" in navigator) || document.hidden) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => (wakeLock = null));
  } catch {
    // Refused, or not on this browser. The screen may sleep; that is all.
  }
}

function joinUrl(c) {
  return `${location.origin}/join?id=${c}`;
}

/* ---- in and out of party mode ---- */

function enterParty() {
  showView("party");
  if (!role) toStart();
}

function toStart(message = "") {
  role = null;
  snap = null;
  resetDrawn();
  $("partyBar").classList.add("hidden");
  $("partyName").value = $("partyName").value || savedName();
  const last = normaliseCode(local.get(LAST_CODE_KEY));
  if (!$("joinCode").value && isValidCode(last)) $("joinCode").value = last;
  startMsg(message);
  showPanel("partyStart");
  keepAwake(false);
}

function backToSolo() {
  if (role) return;
  if (location.pathname === "/join") history.replaceState(null, "", "/");
  showView("solo");
}

/* ---- hosting ---- */

async function host() {
  const name = takeName();
  if (!name) return;
  startMsg("");
  $("hostBtn").disabled = true;
  try {
    const stations = await loadStations();
    beginHosting(new PartyHost({ stations, name }));
  } catch {
    startMsg("Could not load the station list. Reload and try again.");
  } finally {
    $("hostBtn").disabled = false;
  }
}

function beginHosting(r) {
  role = "host";
  room = r;
  resetDrawn();
  room.addEventListener("state", (e) => room === r && draw(e.detail));
  room.addEventListener("status", () => room === r && drawBar());
  room.addEventListener("replay-wanted", () => room === r && makeReplayLink());
  room.open();
  keepAwake(true);
}

function endHosting() {
  room?.close();
  room = null;
  toStart();
}

/* ---- joining ---- */

function join(input) {
  const c = normaliseCode(input);
  if (!isValidCode(c)) {
    startMsg(`A code is ${CODE_LENGTH} characters.`);
    return;
  }
  if (!takeName()) return;
  startMsg("");
  code = c;
  role = "guest";
  retries = 0;
  resetDrawn();
  local.set(LAST_CODE_KEY, c);
  session.set(GUEST_KEY, c);
  connect();
  keepAwake(true);
}

async function connect() {
  clearTimeout(retryTimer);
  guest?.close();
  const g = new Guest();
  guest = g;
  g.addEventListener("status", ({ detail }) => guest === g && onGuestStatus(detail));
  g.addEventListener("message", ({ detail }) => guest === g && onGuestMessage(detail.message));
  if (!snap) notice("Connecting to the host.", { icon: "users" });
  try {
    await g.connect(code, { pid: playerId(), name: savedName() || "Player" });
  } catch {
    if (guest === g) notice("Could not load pairing. Check your connection.", { retry: true, icon: "offline" });
  }
}

function onGuestStatus({ status, message, type }) {
  switch (status) {
    case "connecting":
      if (!snap) notice(retries ? "Reconnecting to the host." : "Connecting to the host.", { icon: "users" });
      break;
    case "connected":
      retries = 0;
      lastHeard = performance.now();
      if (!snap) notice("Connected. Waiting for the host.", { icon: "users" });
      break;
    case "dropped":
      lostHost();
      break;
    case "unreachable":
      // Never opened: a network that will not carry it, not the host leaving.
      snap = null;
      notice(
        "Could not reach the host. Both devices have to be on the same network: join the same wifi, " +
          "or turn on a hotspot on one and join it from the other. Check the code is still the one on screen.",
        { retry: true, icon: "offline" }
      );
      break;
    case "error":
      // While reconnecting, "nobody on that code" is usually the host
      // reloading. Keep trying a few times.
      if (retries > 0 && retries < RETRIES && (type === "peer-unavailable" || !type)) {
        scheduleRetry();
        return;
      }
      snap = null;
      notice(message || "The connection failed.", { retry: true, icon: "offline" });
      break;
    default:
      break;
  }
}

function lostHost() {
  snap = null;
  if (retries < RETRIES) {
    notice("Lost the connection to the host. Reconnecting.", { icon: "users" });
    scheduleRetry();
  } else {
    notice("Lost the connection to the host.", { retry: true, icon: "offline" });
  }
}

function scheduleRetry() {
  retries += 1;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => role === "guest" && connect(), RETRY_MS * retries);
}

const ENDINGS = {
  full: `This game is full: it has ${MAX_PLAYERS} players already.`,
  kicked: "The host took you out of the game.",
  closed: "The host ended the party.",
  outdated: "This device has an older version of the game. Reload the page to update it.",
};

function onGuestMessage(message) {
  lastHeard = performance.now();
  if (message.type === "state") {
    if (typeof message.phase === "string" && Array.isArray(message.players)) draw(message);
    return;
  }
  if (ENDINGS[message.type]) endGuest(ENDINGS[message.type]);
}

// The game is over for this device, not just the link.
function endGuest(text) {
  clearTimeout(retryTimer);
  guest?.close();
  guest = null;
  session.set(GUEST_KEY, null);
  local.set(LAST_CODE_KEY, null);
  role = null;
  snap = null;
  resetDrawn();
  $("partyBar").classList.add("hidden");
  notice(text, { icon: "users" });
  keepAwake(false);
}

function leave() {
  clearTimeout(retryTimer);
  guest?.leave();
  guest = null;
  session.set(GUEST_KEY, null);
  local.set(LAST_CODE_KEY, null);
  $("joinCode").value = "";
  toStart();
}

function notice(text, { retry = false, icon = "users" } = {}) {
  $("partyNoticeIcon").setAttribute("data-icon", icon);
  hydrateIcons($("partyNotice"));
  $("partyNoticeText").textContent = text;
  $("partyRetryBtn").classList.toggle("hidden", !retry);
  $("partyBar").classList.add("hidden");
  showPanel("partyNotice");
}

/* ---- sending a move ---- */

function input(action, extra = {}) {
  if (role === "host") room?.act(HOST_PID, { action, ...extra });
  else guest?.send({ type: "input", action, ...extra });
}

/* ---- drawing a snapshot ---- */

function draw(s) {
  snap = s;
  drawBar();
  switch (s.phase) {
    case "lobby":
      drawLobby(s);
      showPanel("partyLobby");
      break;
    case "ready":
      drawReady(s);
      showPanel("partyReady");
      break;
    case "turn":
      drawPlay(s);
      showPanel("partyPlay");
      break;
    case "result":
      drawResult(s);
      showPanel("partyResult");
      break;
    case "final":
      drawFinal(s);
      showPanel("partyFinal");
      break;
    default:
      break;
  }
}

function drawBar() {
  if (!snap || !role) return;
  const bar = $("partyBar");
  bar.classList.remove("hidden");
  const here = snap.players.filter((p) => p.here && !p.left).length;
  let tone = "ok";
  let text;
  if (role === "host") {
    const st = room?.netStatus ?? { status: "idle" };
    if (st.status === "error") {
      tone = "error";
      text = st.message || "Pairing stopped.";
    } else if (st.status === "connecting") {
      tone = "warn";
      text = "Starting the room.";
    } else {
      text = `Room ${room?.code ?? ""}, ${here} of ${MAX_PLAYERS} players`;
    }
  } else {
    const stale = performance.now() - lastHeard > STALE_MS;
    tone = stale ? "warn" : "ok";
    text = stale ? "The connection to the host looks slow." : `Room ${code}, ${here} of ${MAX_PLAYERS} players`;
  }
  $("partyDot").className = `status-dot ${tone}`;
  $("partyBarText").textContent = text;
  $("partyBarLabel").textContent = armed.leave ? "Tap again" : role === "host" ? "End party" : "Leave";
}

function settingsLine(st) {
  return [
    stationCount(st.stations),
    difficultyOf(st.difficulty).label,
    `${describeTurn(st.turn)} each`,
  ].join(", ");
}

function drawLobby(s) {
  const isHost = s.is_host;
  $("hostInvite").classList.toggle("hidden", !isHost);
  $("hostSettings").classList.toggle("hidden", !isHost);
  $("guestSettings").classList.toggle("hidden", isHost);

  if (isHost) {
    once("invite", s.code ?? "", () => {
      const c = s.code ?? "";
      $("partyCode").textContent = c || "------";
      $("partyLink").textContent = c ? joinUrl(c) : "";
      $("qrHolder").innerHTML = c ? qrToSvg(joinUrl(c), { label: "QR code to join this game" }) : "";
    });
    const st = room?.netStatus?.status;
    $("lobbyStatus").textContent =
      st === "error"
        ? room.netStatus.message
        : st === "connecting"
          ? "Opening the room."
          : "Scan the code, open the link, or type the code under Play with friends.";
  }

  const st = s.settings;
  once("settings", JSON.stringify([st, s.max_stations, customLength, isHost]), () => {
    if (isHost) {
      const preset = LENGTHS.includes(st.stations) && !customLength;
      press("#lengthPicker [data-length]", (el) => (preset ? Number(el.dataset.length) === st.stations : el.dataset.length === "custom"));
      $("customLength").classList.toggle("hidden", preset);
      $("lengthMax").textContent = String(s.max_stations);
      $("customLengthInput").max = String(s.max_stations);
      if (document.activeElement !== $("customLengthInput")) $("customLengthInput").value = String(st.stations);
      press("#partyDifficulty [data-difficulty]", (el) => el.dataset.difficulty === st.difficulty);
      press("#partyTurn [data-turn]", (el) => Number(el.dataset.turn) === st.turn);
    } else {
      $("guestSettingsText").textContent = settingsLine(st);
    }
    $("scoringNote").textContent =
      `Points this game: × ${difficultyOf(st.difficulty).multiplier} for ${difficultyOf(st.difficulty).label.toLowerCase()}, ` +
      `× ${TURN_LIMITS[st.turn]} for ${describeTurn(st.turn)}, up to × 1.5 for speed, ` +
      `and the game score × ${lengthMultiplier(st.stations)} for ${stationCount(st.stations)}.`;
  });

  const players = s.players.filter((p) => !p.left);
  once("lobbyPlayers", JSON.stringify([players, isHost, s.you]), () => {
    $("playersLabel").textContent = `Players, ${players.length} of ${MAX_PLAYERS}`;
    $("lobbyPlayers").innerHTML = players
      .map((p) => {
        const tags = [p.host ? "Host" : "", p.pid === s.you ? "You" : "", p.here ? "" : "Away"].filter(Boolean);
        const kick =
          isHost && !p.host
            ? `<button type="button" class="icon-btn small" data-kick="${escapeHtml(p.pid)}" aria-label="Remove ${escapeHtml(p.name)}"><span data-icon="close"></span></button>`
            : "";
        return `<li class="${p.here ? "" : "away"}"><span class="player-name">${escapeHtml(p.name)}</span>${tags
          .map((t) => `<span class="tag">${t}</span>`)
          .join("")}${kick}</li>`;
      })
      .join("");
    hydrateIcons($("lobbyPlayers"));
  });

  const ready = players.filter((p) => p.here).length >= 2;
  $("startBtn").classList.toggle("hidden", !isHost);
  $("startBtn").disabled = !ready;
  $("newCodeBtn").classList.toggle("hidden", !isHost);
  $("startNote").textContent = isHost
    ? ready
      ? ""
      : "Waiting for at least one more player."
    : "Waiting for the host to start.";
}

function press(selector, isOn) {
  document.querySelectorAll(selector).forEach((el) => {
    const on = isOn(el);
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", String(on));
  });
}

function drawReady(s) {
  $("readyTitle").textContent = `Station ${s.index + 1} of ${s.count}`;
  $("readyCount").textContent = String(Math.max(1, Math.ceil((s.left_ms ?? 0) / 1000)));
  $("readyNote").textContent = settingsLine({ ...s.settings, stations: s.count });
}

function drawPlay(s) {
  const r = s.round;
  $("pStation").textContent = `Station ${s.index + 1} of ${s.count}`;
  $("pClock").textContent = clock(s.left_ms ?? 0);
  $("pTimeBar").firstElementChild.style.transform = `scaleX(${s.phase_ms ? (s.left_ms ?? 0) / s.phase_ms : 0})`;
  $("pTimeBar").classList.toggle("low", (s.left_ms ?? 0) < 10_000);

  if (!r) {
    $("pScore").textContent = "0";
    $("pFeedback").textContent = "You join from the next station.";
    $("pGuessForm").classList.add("hidden");
    $("pActions").classList.add("hidden");
    drawStandingsList(s);
    return;
  }

  // A new station: a clean slate.
  if (drawn.round !== r.id) {
    drawn.round = r.id;
    shownMask = "";
    $("pGuessInput").value = "";
    $("pFeedback").textContent = "";
    $("pFeedback").className = "feedback";
    disarm("hint");
    disarm("giveUp");
    if (matchMedia("(pointer: fine)").matches) $("pGuessInput").focus();
  }

  $("pScore").textContent = String(r.score);
  once("mask", `${r.id}|${r.mask}`, () => {
    const { html, label } = maskMarkup(r.mask, shownMask);
    $("pMask").innerHTML = html;
    $("pMask").setAttribute("aria-label", label);
    shownMask = r.mask;
  });

  const every = difficultyOf(s.settings.difficulty).revealEveryMs;
  const finished = r.solved || r.gave_up;
  const revealing = !finished && r.next_reveal_in != null;
  $("pRevealBar").classList.toggle("hidden", !revealing);
  if (revealing) $("pRevealBar").firstElementChild.style.transform = `scaleX(${1 - Math.min(r.next_reveal_in, every) / every})`;
  $("pRevealNote").textContent = r.solved
    ? "Solved. Waiting for the others."
    : r.gave_up
      ? "Waiting for the others."
      : revealing
        ? `Another letter shows every ${every / 1000} seconds, for 60 points.`
        : "No more letters will show on their own.";

  once("hints", `${r.id}|${JSON.stringify(r.hints)}`, () => {
    $("pHints").innerHTML = hintRows(r.hints);
    $("pLaterHints").innerHTML = laterHintRows(r.hints);
    const box = $("pMapHint");
    const pos = r.hints.position;
    if (pos && Number.isFinite(pos.lat) && Number.isFinite(pos.lon)) {
      box.classList.remove("hidden");
      showStation($("pMap"), pos)
        .then(() => box.scrollIntoView({ block: "nearest", behavior: "smooth" }))
        .catch(() => ($("pMap").innerHTML = `<p class="map-failed">The map did not load.</p>`));
    } else {
      box.classList.add("hidden");
      clearStation($("pMap"));
    }
  });

  const fb = r.feedback;
  if (fb && drawn.feedback !== `${r.id}:${fb.id}`) {
    drawn.feedback = `${r.id}:${fb.id}`;
    $("pFeedback").textContent = String(fb.text ?? "");
    $("pFeedback").className = `feedback${fb.tone ? ` ${fb.tone}` : ""}`;
    if (fb.tone === "miss") {
      const field = $("pGuessInput");
      field.value = "";
      field.classList.remove("shake");
      void field.offsetWidth;
      field.classList.add("shake");
    }
  }

  $("pGuessForm").classList.toggle("hidden", finished);
  $("pActions").classList.toggle("hidden", finished);
  const next = r.next_hint;
  $("pHintBtn").disabled = !next;
  $("pHintBtn").classList.toggle("armed", Boolean(armed.hint && next));
  $("pHintLabel").textContent = !next
    ? "No more hints"
    : armed.hint
      ? `Tap again to spend ${next.penalty} points`
      : `${HINT_LABELS[next.tier]} hint, -${next.penalty}`;
  $("pGiveUpLabel").textContent = armed.giveUp ? "Tap again to give up" : "Give up";
  $("pGiveUpBtn").classList.toggle("armed", Boolean(armed.giveUp));

  drawStandingsList(s);
}

const STATUS_TEXT = { playing: "Guessing", solved: "Solved", gave_up: "Gave up", out: "Out of time" };

function drawStandingsList(s) {
  const players = s.players.filter((p) => !p.left);
  once("pPlayers", JSON.stringify([players, s.you]), () => {
    $("pPlayers").innerHTML = players
      .map((p) => {
        const state = p.here ? (STATUS_TEXT[p.status] ?? "Next station") : "Away";
        return `<li class="${p.here ? "" : "away"}"><span class="player-name">${escapeHtml(p.name)}${
          p.pid === s.you ? ' <span class="tag">You</span>' : ""
        }</span><span class="state ${escapeHtml(p.status ?? "")}">${state}</span><span class="total">${p.total}</span></li>`;
      })
      .join("");
  });
}

function ranked(players) {
  return [...players].sort((a, b) => b.total - a.total || b.solved - a.solved);
}

function rankCell(list, i) {
  return i > 0 && list[i - 1].total === list[i].total ? "=" : String(i + 1);
}

function drawResult(s) {
  const a = s.answer;
  once("result", JSON.stringify([s.index, a, s.round?.scoring, s.round?.score]), () => {
    $("prTitle").textContent = a?.name_en ?? "";
    $("prAlt").innerHTML = a ? altNames(a) : "";
    $("prCodes").innerHTML = a ? codeChips(a.codes ?? []) : "";
    const r = s.round;
    const how = r?.scoring ? breakdown(r.scoring, difficultyOf(s.settings.difficulty).label) : "";
    $("prMine").textContent = !r
      ? ""
      : r.solved
        ? `You solved it for ${r.score} points${how ? `: ${how}` : ""}.`
        : r.gave_up
          ? "You gave up on this one."
          : "You ran out of time on this one.";
  });
  const list = ranked(s.players.filter((p) => !p.left || p.total));
  once("resultTable", JSON.stringify([s.index, list, s.you]), () => {
    $("prTable").innerHTML =
      `<thead><tr><th>#</th><th>Player</th><th>This station</th><th>Total</th></tr></thead><tbody>` +
      list
        .map(
          (p, i) =>
            `<tr${p.pid === s.you ? ' class="me"' : ""}><td>${rankCell(list, i)}</td><td>${escapeHtml(p.name)}</td>` +
            `<td>${p.points == null ? "-" : p.points ? `+${p.points}` : "0"}</td><td>${p.total}</td></tr>`
        )
        .join("") +
      `</tbody>`;
  });
  const last = s.index + 1 >= s.count;
  const secs = Math.max(1, Math.ceil((s.left_ms ?? 0) / 1000));
  $("prNext").textContent = last ? `Final standings in ${secs} s.` : `Next station in ${secs} s.`;
  $("nextBtn").classList.toggle("hidden", !s.is_host);
  $("nextLabel").textContent = last ? "Final standings" : "Next station";
}

function drawFinal(s) {
  const list = ranked(s.players.filter((p) => !p.left || p.total));
  once("final", JSON.stringify([list, s.you, s.length_multiplier]), () => {
    const top = list[0];
    const winners = list.filter((p) => p.total === top?.total);
    $("pfTitle").textContent = !top
      ? "Game over"
      : winners.length > 1
        ? `${winners.map((p) => p.name).join(" and ")} tie on ${top.game}`
        : `${top.name} wins with ${top.game}`;
    $("pfTable").innerHTML =
      `<thead><tr><th>#</th><th>Player</th><th>Solved</th><th>Points</th><th>Game score</th></tr></thead><tbody>` +
      list
        .map(
          (p, i) =>
            `<tr${p.pid === s.you ? ' class="me"' : ""}><td>${rankCell(list, i)}</td><td>${escapeHtml(p.name)}</td>` +
            `<td>${p.solved}</td><td>${p.total}</td><td>${p.game}</td></tr>`
        )
        .join("") +
      `</tbody>`;
    $("pfNote").textContent =
      `Game score is points × ${s.length_multiplier} for ${stationCount(s.count)}. ` +
      "Party games stay off the leaderboard.";
  });
  $("againBtn").classList.toggle("hidden", !s.is_host);
  $("pfWait").classList.toggle("hidden", s.is_host);
  if (s.replay_url && drawn.replayUrl !== s.replay_url) {
    drawn.replayUrl = s.replay_url;
    $("pfShareMsg").textContent = "";
  }
}

/* ---- buttons ---- */

function arm(which, ms, redraw) {
  clearTimeout(armed[which]);
  armed[which] = setTimeout(() => {
    armed[which] = null;
    redraw();
  }, ms);
  redraw();
}

function disarm(which) {
  clearTimeout(armed[which]);
  armed[which] = null;
}

const redrawPlay = () => snap?.phase === "turn" && drawPlay(snap);

function onHint() {
  if (!snap?.round?.next_hint) return;
  if (getSettings().confirm_hints && !armed.hint) {
    arm("hint", 4000, redrawPlay);
    return;
  }
  disarm("hint");
  input("hint");
}

function onGiveUp() {
  if (!armed.giveUp) {
    arm("giveUp", 3000, redrawPlay);
    return;
  }
  disarm("giveUp");
  input("giveup");
}

function onBarButton() {
  if (!armed.leave) {
    arm("leave", 3000, drawBar);
    return;
  }
  disarm("leave");
  if (role === "host") endHosting();
  else leave();
}

// The host makes the link; a guest asks the host to. Everybody then gets it
// in the next snapshot.
async function makeReplayLink() {
  if (!room || room.room.replay_url || makeReplayLink.busy) return;
  makeReplayLink.busy = true;
  $("pfShareMsg").textContent = "Making a link.";
  try {
    room.setReplayUrl(await partyReplayLink(room.replay()));
    $("pfShareMsg").textContent = "";
  } catch {
    $("pfShareMsg").textContent = "Could not make a link.";
  } finally {
    makeReplayLink.busy = false;
  }
}

async function onShareReplay() {
  if (snap?.replay_url) {
    const how = await shareLink(snap.replay_url);
    $("pfShareMsg").textContent = how === "copied" ? "Replay link copied." : how === "failed" ? snap.replay_url : "";
    return;
  }
  if (role === "host") {
    await makeReplayLink();
    if (room?.room.replay_url) onShareReplay();
  } else {
    input("replay");
    $("pfShareMsg").textContent = "Asking the host for the link. Tap again in a moment.";
  }
}

function onWatchReplay() {
  if (role === "host" && room) {
    openReplay({ replay: room.replay(), link: snap?.replay_url ?? null });
  } else if (snap?.replay_url) {
    const url = new URL(snap.replay_url);
    const id = url.pathname.match(/^\/r\/([A-Za-z0-9]{8})$/)?.[1];
    openReplay(id ? { id } : { packed: url.searchParams.get("replay") });
  } else {
    input("replay");
    $("pfShareMsg").textContent = "Asking the host for the replay. Tap again in a moment.";
  }
}

function wire() {
  $("partyBtn").addEventListener("click", () => {
    if (currentView() !== "party") enterParty();
    else backToSolo();
  });
  $("partyBackBtn").addEventListener("click", backToSolo);
  $("hostBtn").addEventListener("click", host);
  $("joinForm").addEventListener("submit", (e) => {
    e.preventDefault();
    join($("joinCode").value);
  });
  $("joinCode").addEventListener("input", (e) => {
    const c = normaliseCode(e.target.value);
    if (e.target.value !== c) e.target.value = c;
  });
  $("partyRetryBtn").addEventListener("click", () => {
    if (!code) return toStart();
    role = "guest";
    retries = 0;
    connect();
  });
  $("partyNoticeBack").addEventListener("click", () => {
    if (role === "guest") leave();
    else toStart();
  });
  $("partyBarBtn").addEventListener("click", onBarButton);

  // Lobby, host only.
  $("partyCode").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(room?.code ?? "");
      $("lobbyStatus").textContent = "Code copied.";
    } catch {
      // No clipboard: the code is on screen to read out.
    }
  });
  $("copyLinkBtn").addEventListener("click", async () => {
    if (!room?.code) return;
    const how = await shareLink(joinUrl(room.code), "Join my MRT Station Guesser game");
    if (how === "copied") $("lobbyStatus").textContent = "Link copied.";
  });
  $("newCodeBtn").addEventListener("click", () => room?.newCode());
  $("lengthPicker").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-length]");
    if (!btn || !room) return;
    if (btn.dataset.length === "custom") {
      customLength = true;
      drawn.settings = null;
      if (snap) drawLobby(snap);
      $("customLengthInput").focus();
      return;
    }
    customLength = false;
    room.setSettings({ stations: Number(btn.dataset.length) });
  });
  $("customLengthInput").addEventListener("input", (e) => {
    const n = Number(e.target.value);
    if (Number.isInteger(n) && n >= 1) room?.setSettings({ stations: n });
  });
  $("customLengthInput").addEventListener("change", () => {
    drawn.settings = null;
  });
  $("partyDifficulty").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-difficulty]");
    if (btn) room?.setSettings({ difficulty: btn.dataset.difficulty });
  });
  $("partyTurn").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-turn]");
    if (btn) room?.setSettings({ turn: Number(btn.dataset.turn) });
  });
  $("lobbyPlayers").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-kick]");
    if (btn) room?.kick(btn.dataset.kick);
  });
  $("startBtn").addEventListener("click", () => room?.start());

  // A station.
  $("pGuessForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("pGuessInput").value.trim();
    if (!text) return $("pGuessInput").focus();
    input("guess", { text });
  });
  $("pHintBtn").addEventListener("click", onHint);
  $("pGiveUpBtn").addEventListener("click", onGiveUp);
  $("nextBtn").addEventListener("click", () => room?.skip());
  $("againBtn").addEventListener("click", () => room?.playAgain());
  $("pfShareBtn").addEventListener("click", onShareReplay);
  $("pfWatchBtn").addEventListener("click", onWatchReplay);

  // A guest pings when it has nothing else to say, so the host can tell a
  // quiet player from a vanished one; and the bar says when the host has gone
  // quiet.
  setInterval(() => {
    if (role !== "guest") return;
    if (guest?.status === "connected") guest.send({ type: "ping" });
    if (snap) drawBar();
  }, 1000);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (role) keepAwake(true);
    // Back from the background with a link that died meanwhile.
    if (role === "guest" && guest?.status === "dropped") {
      retries = 0;
      connect();
    }
  });

  // Closing the hosting tab ends the game for everybody in it.
  window.addEventListener("beforeunload", (e) => {
    if (role !== "host" || !snap || snap.players.filter((p) => p.here).length < 2) return;
    e.preventDefault();
    e.returnValue = "";
  });

  document.addEventListener("mrt:view", (e) => {
    $("partyBtn").setAttribute("aria-pressed", String(e.detail === "party"));
  });
}

function fillChoices() {
  $("partyDifficulty").innerHTML = Object.entries(DIFFICULTIES)
    .map(([id, d]) => `<button class="mode-btn" type="button" data-difficulty="${id}" aria-pressed="false">${d.label}</button>`)
    .join("");
  $("partyTurn").innerHTML = PARTY_TURNS.map(
    (t) => `<button class="mode-btn" type="button" data-turn="${t}" aria-pressed="false">${describeTurn(t)}</button>`
  ).join("");
}

// Returns true when the page should open on a party game rather than a solo
// round: a join link, or a game this tab was already in.
export function initParty() {
  fillChoices();
  wire();
  applyMapStyle();
  $("partyName").value = savedName();

  const saved = savedRoom();
  if (saved) {
    // This tab was hosting: carry on, on the same code.
    showView("party");
    notice("Reopening your room.", { icon: "users" });
    loadStations()
      .then((stations) => beginHosting(new PartyHost({ stations, name: savedName(), saved })))
      .catch(() => toStart("Could not reopen the room. Host a new one."));
    return true;
  }

  const fromLink = location.pathname === "/join" ? normaliseCode(new URLSearchParams(location.search).get("id")) : "";
  const rejoin = normaliseCode(session.get(GUEST_KEY));
  if (fromLink || isValidCode(rejoin)) {
    const c = fromLink || rejoin;
    // The address goes back to the page's own; a reload rejoins from
    // session storage instead.
    if (location.pathname === "/join") history.replaceState(null, "", "/");
    showView("party");
    toStart();
    $("joinCode").value = c;
    if (isValidCode(c) && savedName()) join(c);
    else {
      startMsg(isValidCode(c) ? "Enter your name, then Join." : "");
      $("partyName").focus();
    }
    return true;
  }
  return false;
}
