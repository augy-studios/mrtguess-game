// The game screen. The API holds every rule and the answer; this shows what
// it says and sends what the player does.

import { api } from "./api.js";
import { openLeaderboard } from "./leaderboard.js";
import { clearStation, showStation } from "./map.js";
import { escapeHtml, hydrateIcons } from "./ui.js";

const ROUND_STORAGE = "mrtguessr.round";
const NAME_STORAGE = "mrtguessr.name";

const HINT_LABELS = { 2: "Station code", 3: "Map", 4: "Chinese name", 5: "Letter" };
// For the countdown bar only. The clock itself is the server's.
const REVEAL_EVERY_MS = 15_000;
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
const isLetter = (ch) => /\p{L}/u.test(ch);
const safeHex = (hex) => (/^#[0-9a-f]{6}$/i.test(hex ?? "") ? hex : "#748477");

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
  const before = [...shownMask];
  const chars = [...mask];
  const sameRound = before.length === chars.length;

  const words = [[]];
  chars.forEach((ch, i) => {
    if (ch === " ") words.push([]);
    else words.at(-1).push({ ch, i });
  });

  $("mask").innerHTML = words
    .map(
      (word) =>
        `<span class="word">${word
          .map(({ ch, i }) => {
            if (ch === "_") return `<span class="tile blank"></span>`;
            if (!isLetter(ch)) return `<span class="sep">${escapeHtml(ch)}</span>`;
            const fresh = sameRound && before[i] === "_";
            return `<span class="tile${fresh ? " fresh" : ""}">${escapeHtml(ch)}</span>`;
          })
          .join("")}</span>`
    )
    .join("");

  const spoken = words.map((word) => word.map(({ ch }) => (ch === "_" ? "blank" : ch)).join(", ")).join("; next word: ");
  $("mask").setAttribute("aria-label", `Station name: ${spoken}`);
  shownMask = mask;
}

function hintRow(label, content) {
  return `<div class="hint-row"><dt>${label}</dt><dd>${content}</dd></div>`;
}

function renderHints(v) {
  const h = v.hints;
  const rows = [
    hintRow(
      "Line colour",
      h.colors
        .map((c) => `<span class="chip"><span class="dot" style="--dot:${safeHex(c.hex)}"></span>${escapeHtml(c.name)}</span>`)
        .join("")
    ),
  ];
  if (h.codes?.length) {
    rows.push(hintRow(h.codes.length > 1 ? "Codes" : "Code", h.codes.map((c) => `<span class="chip code">${escapeHtml(c)}</span>`).join("")));
  }
  if (h.line_names?.length) {
    rows.push(hintRow(h.line_names.length > 1 ? "Lines" : "Line", escapeHtml(h.line_names.join(", "))));
  }
  $("hints").innerHTML = rows.join("");
  // Bought after the map, so shown below it.
  $("laterHints").innerHTML = h.name_zh
    ? hintRow("Chinese name", `<span class="zh" lang="zh-Hans">${escapeHtml(h.name_zh)}</span>`)
    : "";

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
    clearStation();
  }
}

function renderReveal(v) {
  const bar = $("revealBar");
  const fill = bar.firstElementChild;
  let note;
  if (v.expired) {
    note = "This round has timed out. Give up to see the answer.";
  } else if (v.next_reveal_in == null) {
    note = "No more letters will show on their own.";
  } else {
    note = "Another letter shows every 15 seconds, for 60 points.";
    const left = Math.min(v.next_reveal_in, REVEAL_EVERY_MS);
    fill.style.setProperty("--from", String(1 - left / REVEAL_EVERY_MS));
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
  $("hintLabel").textContent = next ? `${HINT_LABELS[next.tier]} hint, -${next.penalty}` : "No more hints";
  $("guessBtn").disabled = busy || v.expired;
  $("giveUpBtn").disabled = busy;
}

function render(v) {
  view = v;
  $("letterCount").textContent = `${v.length} letters`;
  $("score").textContent = v.score;
  renderMask(v.mask);
  renderHints(v);
  renderReveal(v);
  renderActions(v);
}

// The clock. The server reveals letters on its own schedule; the page asks
// again when the next one is due, and only while it is being looked at.

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function schedulePoll() {
  stopPolling();
  if (!isLive(view) || view.expired || view.next_reveal_in == null) return;
  pollTimer = setTimeout(poll, view.next_reveal_in + 400);
}

async function poll() {
  pollTimer = null;
  if (!isLive(view) || document.hidden) return;
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
      : err.status === 429 || err.code === "no_more_hints" || err.code === "busy"
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

function onHint() {
  const bought = view?.next_hint;
  if (!bought) return;
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

function finish(v) {
  stopPolling();
  store.remove(ROUND_STORAGE);
  view = v;
  const a = v.answer;

  $("resultTitle").textContent = v.solved ? a.name_en : `It was ${a.name_en}`;
  const alt = [
    a.name_zh ? `<span lang="zh-Hans">${escapeHtml(a.name_zh)}</span>` : "",
    a.name_ta ? `<span lang="ta">${escapeHtml(a.name_ta)}</span>` : "",
  ].filter(Boolean);
  $("resultAlt").innerHTML = alt.join(" · ");
  $("resultAlt").classList.toggle("hidden", !alt.length);
  $("resultCodes").innerHTML = (a.codes ?? []).map((c) => `<span class="chip code">${escapeHtml(c)}</span>`).join("");
  $("resultScore").textContent = v.solved ? `Solved for ${v.score} points.` : "No points this round.";

  $("submitForm").classList.toggle("hidden", !v.solved);
  $("submitted").classList.add("hidden");
  $("submitMsg").textContent = "";
  $("nameInput").value = store.get(NAME_STORAGE) ?? "";
  $("submitBtn").disabled = false;

  showPanel("result");
  say("");
  $("playAgainBtn").focus();
}

async function onSubmit(event) {
  event.preventDefault();
  const name = $("nameInput").value.trim();
  const msg = $("submitMsg");
  if (!name) {
    msg.textContent = "Enter a name.";
    $("nameInput").focus();
    return;
  }
  $("submitBtn").disabled = true;
  msg.textContent = "";
  try {
    const r = await api.submit(view.round_id, name);
    store.set(NAME_STORAGE, r.name);
    const rounds = r.rounds === 1 ? "1 round" : `${r.rounds} rounds`;
    $("submittedText").textContent =
      `Added as ${r.name}. Best score ${r.best_score}, ranked ${r.rank}. ` +
      `Total ${r.total} over ${rounds}, ranked ${r.total_rank}.`;
    $("submitForm").classList.add("hidden");
    $("submitted").classList.remove("hidden");
  } catch (err) {
    msg.textContent =
      err.code === "offline"
        ? "No connection. Try again once you are back online."
        : err.message || "That did not go through. Try again in a moment.";
    if (err.code === "already_submitted" || err.code === "expired") $("submitForm").classList.add("hidden");
    else $("submitBtn").disabled = false;
  }
}

// Starting and resuming.

function showNotice(text, iconName = "flag") {
  stopPolling();
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
    v = await api.newRound();
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
  $("noticeBtn").disabled = true;
  try {
    await resumeOrStart();
  } finally {
    starting = false;
    $("noticeBtn").disabled = false;
  }
}

export function initGame() {
  $("guessForm").addEventListener("submit", onGuess);
  $("hintBtn").addEventListener("click", onHint);
  $("giveUpBtn").addEventListener("click", onGiveUp);
  $("submitForm").addEventListener("submit", onSubmit);
  $("playAgainBtn").addEventListener("click", newRound);
  $("resultBoardBtn").addEventListener("click", () => openLeaderboard());
  $("noticeBtn").addEventListener("click", start);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && isLive(view) && !view.expired) {
      stopPolling();
      poll();
    }
  });
  window.addEventListener("online", () => {
    const notice = $("notice");
    if (!notice.classList.contains("hidden") && notice.dataset.kind === "offline") start();
  });

  start();
}
