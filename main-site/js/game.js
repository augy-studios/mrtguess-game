// The game screen. The API holds every rule and the answer; this shows what
// it says and sends what the player does.

import { api } from "./api.js";
import { openLeaderboard } from "./leaderboard.js";
import { clearStation, showStation } from "./map.js";
import { getSettings, saveSettings } from "./settings.js";
import { HINT_LABELS, describeTurn, difficultyOf } from "./rules.js";
import { altNames, breakdown, clock, codeChips, hintRows, laterHintRows, maskMarkup } from "./round-view.js";
import { shareLink, soloReplayLink } from "./replay.js";
import { hydrateIcons } from "./ui.js";

const ROUND_STORAGE = "mrtguessr.round";

const GONE = new Set(["round_not_found", "round_over", "round_expired"]);

const $ = (id) => document.getElementById(id);

let view = null;
let shownMask = "";
let pollTimer = null;
let busy = false;
// Bumped by every request, so a slow clock read never overwrites a newer
// answer from a guess or hint.
let seq = 0;
let giveUpTimer = null;
let hintTimer = null;
// A timed round: when its time runs out, by this page's clock, and the
// ticker that counts it down.
let deadline = null;
let clockTimer = null;
// Hidden behind a party game or a replay: no polling, no countdown.
let suspended = false;
let started = false;

const store = {
  get: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private mode: nothing to remember across reloads, nothing broken.
    }
  },
  remove: (key) => {
    try {
      localStorage.removeItem(key);
    } catch {
      // As above.
    }
  },
};

const isLive = (v) => v && !v.solved && !v.gave_up;

function showPanel(id) {
  for (const panel of ["play", "result", "notice"]) $(panel).classList.toggle("hidden", panel !== id);
}

function say(text, tone = "") {
  const el = $("feedback");
  el.textContent = text;
  el.className = `feedback${tone ? ` ${tone}` : ""}`;
}

function focusGuess(force = false) {
  // On a phone, focusing unasked pops the keyboard over the word.
  if (force || matchMedia("(pointer: fine)").matches) $("guessInput").focus();
}

// Rendering the live round.

function renderMask(mask) {
  const { html, label } = maskMarkup(mask, shownMask);
  $("mask").innerHTML = html;
  $("mask").setAttribute("aria-label", label);
  shownMask = mask;
}

function renderHints(v) {
  const h = v.hints;
  $("hints").innerHTML = hintRows(h);
  $("laterHints").innerHTML = laterHintRows(h);

  const mapBox = $("mapHint");
  if (h.position) {
    const fresh = mapBox.dataset.round !== v.round_id;
    mapBox.dataset.round = v.round_id;
    mapBox.classList.remove("hidden");
    if (fresh) {
      showStation($("map"), h.position)
        .then(() => mapBox.scrollIntoView({ block: "nearest", behavior: "smooth" }))
        .catch(() => {
          $("map").innerHTML = `<p class="map-failed">The map did not load. Reload to try again.</p>`;
        });
    }
  } else {
    mapBox.classList.add("hidden");
    delete mapBox.dataset.round;
    clearStation($("map"));
  }
}

function renderReveal(v) {
  const every = difficultyOf(v.difficulty).revealEveryMs;
  const bar = $("revealBar");
  const fill = bar.firstElementChild;
  let note;
  if (v.expired) {
    note = v.turn_seconds ? "Time is up." : "This round has timed out. Give up to see the answer.";
  } else if (v.next_reveal_in == null) {
    note = "No more letters will show on their own.";
  } else {
    note = `Another letter shows every ${every / 1000} seconds, for 60 points.`;
    const left = Math.min(v.next_reveal_in, every);
    fill.style.setProperty("--from", String(1 - left / every));
    fill.style.setProperty("--ms", `${left}ms`);
    // Restart the animation from where this reveal's wait stands.
    fill.style.animation = "none";
    void fill.offsetWidth;
    fill.style.animation = "";
  }
  bar.classList.toggle("hidden", v.expired || v.next_reveal_in == null);
  $("revealNote").textContent = note;
}

function renderActions(v) {
  const next = v.next_hint;
  const hintBtn = $("hintBtn");
  hintBtn.disabled = busy || !next || v.expired;
  hintBtn.classList.toggle("armed", Boolean(hintTimer && next));
  $("hintLabel").textContent = !next
    ? "No more hints"
    : hintTimer
      ? `Tap again to spend ${next.penalty} points`
      : `${HINT_LABELS[next.tier]} hint, -${next.penalty}`;
  $("guessBtn").disabled = busy || v.expired;
  $("giveUpBtn").disabled = busy;
}

function renderSettings(v) {
  const bits = [difficultyOf(v.difficulty).label];
  if (v.turn_seconds) bits.push(describeTurn(v.turn_seconds));
  $("roundMode").textContent = bits.join(", ");
}

function render(v) {
  view = v;
  $("letterCount").textContent = `${v.length} letters`;
  $("score").textContent = v.score;
  renderSettings(v);
  renderMask(v.mask);
  renderHints(v);
  renderReveal(v);
  renderActions(v);
  startClock(v);
}

// The time limit. The server's clock is the one that counts; this one only
// shows it, from time_left in the latest answer, and gives up for the player
// when it runs out so the answer shows.

function stopClock() {
  clearInterval(clockTimer);
  clockTimer = null;
}

function startClock(v) {
  stopClock();
  const timed = isLive(v) && v.time_left != null;
  $("timeBar").classList.toggle("hidden", !timed);
  $("timeLeft").classList.toggle("hidden", !timed);
  if (!timed) {
    deadline = null;
    return;
  }
  deadline = performance.now() + v.time_left;
  tickClock();
  clockTimer = setInterval(tickClock, 250);
}

function tickClock() {
  if (!view || deadline == null) return;
  const left = Math.max(0, deadline - performance.now());
  $("timeLeft").textContent = clock(left);
  $("timeBar").firstElementChild.style.transform = `scaleX(${left / (view.turn_seconds * 1000)})`;
  $("timeBar").classList.toggle("low", left < 10_000);
  if (left > 0 || suspended) return;
  stopClock();
  timeUp();
}

function timeUp() {
  if (!isLive(view)) return;
  // A guess on its way is still judged; this waits for it.
  if (busy) {
    setTimeout(timeUp, 300);
    return;
  }
  disarmGiveUp();
  act(async () => finish(await api.giveUp(view.round_id), { timeUp: true }));
}

// The clock. The server reveals letters on its own schedule; the page asks
// again when the next one is due, and only while it is being looked at.

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll() {
  stopPolling();
  if (suspended || !isLive(view) || view.expired || view.next_reveal_in == null) return;
  pollTimer = setTimeout(poll, view.next_reveal_in + 400);
}

async function poll() {
  pollTimer = null;
  if (!isLive(view) || document.hidden || suspended) return;
  if (busy) {
    pollTimer = setTimeout(poll, 1000);
    return;
  }
  const mine = ++seq;
  try {
    const next = await api.state(view.round_id);
    if (mine !== seq) return;
    render(next);
    schedulePoll();
  } catch (err) {
    if (mine !== seq) return;
    if (GONE.has(err.code)) roundGone();
    else pollTimer = setTimeout(poll, 5000);
  }
}

// Player actions.

function setBusy(on) {
  busy = on;
  if (view && isLive(view)) renderActions(view);
}

function failed(err) {
  if (GONE.has(err.code)) return roundGone();
  const text =
    err.code === "offline"
      ? "No connection. Try again once you are back online."
      : err.status === 429 || err.code === "no_more_hints" || err.code === "busy" || err.code === "too_many"
        ? err.message
        : "The game server did not answer. Try again in a moment.";
  say(text, "error");
}

async function act(work) {
  if (busy || !isLive(view)) return;
  setBusy(true);
  ++seq;
  try {
    await work();
  } catch (err) {
    failed(err);
  } finally {
    setBusy(false);
  }
}

function onGuess(event) {
  event.preventDefault();
  const input = $("guessInput");
  const text = input.value.trim();
  if (!text) {
    focusGuess(true);
    return;
  }
  act(async () => {
    const next = await api.guess(view.round_id, text);
    if (next.correct) {
      finish(next);
      return;
    }
    input.value = "";
    render(next);
    schedulePoll();
    say(`Not ${text}. 20 points off.`, "miss");
    input.classList.remove("shake");
    void input.offsetWidth;
    input.classList.add("shake");
    focusGuess(true);
  });
}

function disarmHint() {
  clearTimeout(hintTimer);
  hintTimer = null;
  if (isLive(view)) renderActions(view);
}

function onHint() {
  const bought = view?.next_hint;
  if (!bought) return;
  // With "Ask before buying a hint" on, the first tap only asks.
  if (getSettings().confirm_hints && !hintTimer) {
    hintTimer = setTimeout(disarmHint, 4000);
    renderActions(view);
    return;
  }
  disarmHint();
  act(async () => {
    const next = await api.hint(view.round_id);
    render(next);
    schedulePoll();
    say(`${HINT_LABELS[bought.tier]} hint, ${next.penalty ?? bought.penalty} points off.`);
  });
}

function disarmGiveUp() {
  clearTimeout(giveUpTimer);
  giveUpTimer = null;
  $("giveUpBtn").classList.remove("armed");
  $("giveUpLabel").textContent = "Give up";
}

// Two taps, so a stray one does not end the round.
function onGiveUp() {
  if (!giveUpTimer) {
    $("giveUpBtn").classList.add("armed");
    $("giveUpLabel").textContent = "Tap again to give up";
    giveUpTimer = setTimeout(disarmGiveUp, 3000);
    return;
  }
  disarmGiveUp();
  act(async () => finish(await api.giveUp(view.round_id)));
}

// The end of a round.

function finish(v, { timeUp = false } = {}) {
  stopPolling();
  stopClock();
  store.remove(ROUND_STORAGE);
  view = v;
  const a = v.answer;

  $("resultTitle").textContent = v.solved ? a.name_en : timeUp ? `Time is up. It was ${a.name_en}` : `It was ${a.name_en}`;
  const alt = altNames(a);
  $("resultAlt").innerHTML = alt;
  $("resultAlt").classList.toggle("hidden", !alt);
  $("resultCodes").innerHTML = codeChips(a.codes ?? []);
  $("resultScore").textContent = v.solved ? `Solved for ${v.score} points.` : "No points this round.";
  const how = v.scoring ? breakdown(v.scoring, difficultyOf(v.difficulty).label) : "";
  $("resultBreakdown").textContent = how ? `${how} = ${v.score}` : "";
  $("resultBreakdown").classList.toggle("hidden", !how);

  const prefs = getSettings();
  $("submitForm").classList.toggle("hidden", !v.solved);
  $("submitted").classList.add("hidden");
  $("submitMsg").textContent = "";
  $("nameInput").value = prefs.name ?? "";
  $("submitBtn").disabled = false;
  $("shareReplayBtn").disabled = false;
  $("shareMsg").textContent = "";

  showPanel("result");
  say("");
  $("playAgainBtn").focus();

  if (v.solved && prefs.auto_submit && prefs.name) submitAs(prefs.name, true);
}

async function onShareReplay() {
  if (!view?.round_id) return;
  const btn = $("shareReplayBtn");
  const msg = $("shareMsg");
  btn.disabled = true;
  msg.textContent = "Making a link.";
  try {
    const url = await soloReplayLink(view.round_id, getSettings().name);
    const how = await shareLink(url);
    // Where it could not be shared or copied, the link itself, to copy by hand.
    msg.textContent = how === "copied" ? "Replay link copied." : how === "failed" ? url : "";
  } catch (err) {
    msg.textContent =
      err.code === "offline" ? "Making a replay link needs a connection." : err.message || "Could not make a link. Try again.";
  } finally {
    btn.disabled = false;
  }
}

// Adds the round under a name, typed or saved. Any name that goes through
// becomes the saved one, as on Telegram.
async function submitAs(name, auto = false) {
  const msg = $("submitMsg");
  $("submitBtn").disabled = true;
  msg.textContent = auto ? `Adding as ${name}.` : "";
  try {
    const r = await api.submit(view.round_id, name);
    saveSettings({ name: r.name });
    const rounds = r.rounds === 1 ? "1 round" : `${r.rounds} rounds`;
    $("submittedText").textContent =
      `Added as ${r.name}. Best score ${r.best_score}, ranked ${r.rank}. ` +
      `Total ${r.total} over ${rounds}, ranked ${r.total_rank}.`;
    $("submitForm").classList.add("hidden");
    $("submitted").classList.remove("hidden");
  } catch (err) {
    if (err.code === "offline") msg.textContent = "No connection. Try again once you are back online.";
    else if (auto && err.status === 400) msg.textContent = "Your saved name was refused, so this round was not added. Change it in Settings.";
    else if (auto && err.status !== 409 && err.status !== 410) msg.textContent = "This round could not be added automatically. Try the button.";
    else msg.textContent = err.message || "That did not go through. Try again in a moment.";
    if (["already_submitted", "expired", "too_fast", "overlap"].includes(err.code)) $("submitForm").classList.add("hidden");
    else $("submitBtn").disabled = false;
  }
}

function onSubmit(event) {
  event.preventDefault();
  const name = $("nameInput").value.trim();
  if (!name) {
    $("submitMsg").textContent = "Enter a name.";
    $("nameInput").focus();
    return;
  }
  submitAs(name);
}

// Starting and resuming.

function showNotice(text, iconName = "flag") {
  stopPolling();
  stopClock();
  $("notice").dataset.kind = iconName;
  $("noticeIcon").setAttribute("data-icon", iconName);
  hydrateIcons($("notice"));
  $("noticeText").textContent = text;
  $("noticeBtn").classList.remove("hidden");
  showPanel("notice");
}

function roundGone() {
  store.remove(ROUND_STORAGE);
  view = null;
  showNotice("That round is over.");
  $("noticeBtnLabel").textContent = "New round";
}

function startFailed(err) {
  if (err.code === "offline") {
    showNotice("You are offline. Rounds need a connection; this page will carry on once you are back.", "offline");
  } else {
    showNotice(err.status === 429 ? err.message : "The game server did not answer. Try again in a moment.");
  }
  $("noticeBtnLabel").textContent = "Try again";
}

function beginRound(v) {
  shownMask = "";
  say("");
  $("guessInput").value = "";
  disarmGiveUp();
  clearTimeout(hintTimer);
  hintTimer = null;
  showPanel("play");
  render(v);
  schedulePoll();
}

async function newRound() {
  if (busy) return;
  busy = true;
  ++seq;
  stopPolling();
  $("playAgainBtn").disabled = true;
  let v = null;
  try {
    const { difficulty, turn_seconds } = getSettings();
    v = await api.newRound({ difficulty, turn_seconds });
  } catch (err) {
    startFailed(err);
  }
  busy = false;
  $("playAgainBtn").disabled = false;
  if (!v) return;
  store.set(ROUND_STORAGE, v.round_id);
  beginRound(v);
  focusGuess(true);
}

// A round left open in this browser carries on after a reload.
async function resumeOrStart() {
  const saved = store.get(ROUND_STORAGE);
  if (saved) {
    try {
      const v = await api.state(saved);
      if (isLive(v) && !v.expired) {
        beginRound(v);
        focusGuess();
        return;
      }
    } catch (err) {
      if (err.code === "offline") return startFailed(err);
    }
    store.remove(ROUND_STORAGE);
  }
  await newRound();
}

let starting = false;

async function start() {
  if (starting) return;
  starting = true;
  started = true;
  $("noticeBtn").disabled = true;
  try {
    await resumeOrStart();
  } finally {
    starting = false;
    $("noticeBtn").disabled = false;
  }
}

// Out of sight behind a party game or a replay, the round asks the server
// nothing. Back in sight, it catches up at once; a timed round's clock is
// the server's, so time spent elsewhere still counted.
function pause() {
  suspended = true;
  stopPolling();
}

function resume() {
  suspended = false;
  if (!started) {
    start();
    return;
  }
  if (isLive(view)) {
    stopPolling();
    poll();
    if (deadline != null) tickClock();
  }
}

// autostart false leaves the first round for later: a page opened on a
// party or replay link should not start a round nobody is looking at.
export function initGame({ autostart = true } = {}) {
  $("guessForm").addEventListener("submit", onGuess);
  $("hintBtn").addEventListener("click", onHint);
  $("giveUpBtn").addEventListener("click", onGiveUp);
  $("submitForm").addEventListener("submit", onSubmit);
  $("playAgainBtn").addEventListener("click", newRound);
  $("resultBoardBtn").addEventListener("click", () => openLeaderboard());
  $("shareReplayBtn").addEventListener("click", onShareReplay);
  $("noticeBtn").addEventListener("click", start);

  document.addEventListener("mrt:view", (e) => (e.detail === "solo" ? resume() : pause()));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !suspended && isLive(view) && !view.expired) {
      stopPolling();
      poll();
    }
  });
  window.addEventListener("online", () => {
    const notice = $("notice");
    if (!suspended && !notice.classList.contains("hidden") && notice.dataset.kind === "offline") start();
  });

  if (autostart) start();
  else suspended = true;
}
