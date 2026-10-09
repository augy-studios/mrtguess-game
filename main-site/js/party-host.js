// The party game, run on the hosting device.
//
// A party has no server, so the host is the referee: it picks the stations,
// keeps the clock, judges every guess with js/rules.js and sends each player
// what they may see, twenty times a second, over p2p.js. The host plays too,
// through act() rather than the network, so a party is the host and up to
// seven guests.
//
// The answer is in this device's memory for the whole turn. That is fine
// among friends, and it is why party scores never go on the leaderboard.
//
// The room is plain data, saved to session storage as it changes, so a host
// that reloads comes back to the same game on the same code and its guests
// reconnect to it.

import { Host, generateCode, isValidCode, PROTOCOL_VERSION } from "./p2p.js";
import {
  DEFAULT_DIFFICULTY,
  HINT_LABELS,
  MAX_EVENTS,
  PARTY_TURN_DEFAULT,
  WRONG_GUESS_COST,
  cleanDifficulty,
  cleanTurn,
  gameScore,
  hintsFor,
  lengthMultiplier,
  letterPositions,
  maskOf,
  maxReveals,
  multipliers,
  nextHint,
  nextRevealIn,
  shuffle,
  turnMs,
  turnState,
} from "./rules.js";
import { MAX_PLAYERS, cleanText } from "./replay-format.js";

export { MAX_PLAYERS };
export const LENGTHS = [5, 10, 20];
export const PARTY_TURNS = [30, 60, 120];
export const HOST_PID = "host";

const READY_MS = 3000;
const RESULT_MS = 10_000;
const TICK_MS = 50;
// A guest heard from in nothing at all for this long is treated as gone. It
// pings every second, so this is several missed pings, not one slow one.
const SILENT_MS = 5000;
const SAVE_EVERY_MS = 500;

const CODE_KEY = "mrtguessr.party.hostCode";
const ROOM_KEY = "mrtguessr.party.room";

const storage = (kind) => ({
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
      // Blocked storage: a reload loses the room, nothing else.
    }
  },
});
const local = storage("localStorage");
const session = storage("sessionStorage");

export function savedRoom() {
  try {
    const saved = JSON.parse(session.get(ROOM_KEY) ?? "null");
    return saved?.room?.seats ? saved : null;
  } catch {
    return null;
  }
}

export const cleanSeatName = (value) => cleanText(value, 20);
const cleanPid = (value) => (typeof value === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(value) ? value : null);

function randomInt(n) {
  const limit = Math.floor(0x100000000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % n;
  }
}

export class PartyHost extends EventTarget {
  // stations: loadStations()'s result. saved: savedRoom(), to carry on.
  constructor({ stations, name, saved = null }) {
    super();
    this.stations = stations;
    this.code = saved?.code ?? null;
    this.room = saved?.room ?? {
      phase: "lobby",
      settings: { stations: 10, difficulty: DEFAULT_DIFFICULTY, turn: PARTY_TURN_DEFAULT },
      seats: [{ pid: HOST_PID, name: cleanSeatName(name) || "Host", host: true, total: 0, solved: 0, left: false }],
      order: [],
      index: -1,
      ends_at: null,
      turn: null,
      history: [],
      roster: [],
      started_at: null,
      replay_url: null,
    };
    this.net = null;
    this.netStatus = { status: "idle" };
    this.peers = new Map(); // peer id -> pid
    this.heard = new Map(); // peer id -> last message, Date.now()
    this.retriedTaken = false;
    this.dirty = true;
    this.savedAt = 0;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /* ---- the network ---- */

  open() {
    const stored = this.code ?? local.get(CODE_KEY);
    this.startNet(isValidCode(stored) ? stored : generateCode());
  }

  // Drops everybody and publishes a fresh code, for when the old one was
  // shown to people who should not have it.
  newCode() {
    this.startNet(generateCode());
  }

  async startNet(code) {
    const old = this.net;
    this.net = null;
    old?.close();
    this.peers.clear();
    this.heard.clear();

    this.code = code;
    local.set(CODE_KEY, code);
    this.changed();

    const net = new Host({ maxGuests: MAX_PLAYERS - 1 });
    this.net = net;
    net.addEventListener("status", ({ detail }) => {
      if (this.net !== net) return;
      // Something else holds the code: another tab, or the broker still
      // releasing it after a reload. A fresh code, once.
      if (detail.taken && !this.retriedTaken) {
        this.retriedTaken = true;
        this.startNet(generateCode());
        return;
      }
      if (detail.status === "waiting" || detail.status === "connected") this.retriedTaken = false;
      this.setNetStatus(detail);
    });
    net.addEventListener("join", ({ detail }) => this.net === net && this.onJoin(detail.id, detail.metadata));
    net.addEventListener("leave", ({ detail }) => this.net === net && this.onAway(detail.id));
    net.addEventListener("message", ({ detail }) => this.net === net && this.onMessage(detail.from, detail.message));

    try {
      await net.start(code);
    } catch {
      if (this.net !== net) return;
      this.net = null;
      this.setNetStatus({ status: "error", message: "Could not load pairing. Check your connection." });
    }
  }

  setNetStatus(detail) {
    this.netStatus = detail;
    this.dispatchEvent(new CustomEvent("status", { detail }));
  }

  // Ends the party for everybody, and retires the code.
  close() {
    clearInterval(this.timer);
    const net = this.net;
    this.net = null;
    for (const peer of [...this.peers.keys()]) net?.dismiss(peer, { type: "closed" });
    this.peers.clear();
    // A moment for the goodbyes to go out before the peer goes.
    setTimeout(() => net?.close(), 500);
    session.set(ROOM_KEY, null);
    local.set(CODE_KEY, null);
  }

  onJoin(id, metadata) {
    const pid = cleanPid(metadata?.pid);
    if (!pid || pid === HOST_PID) {
      this.net.dismiss(id, { type: "outdated" });
      return;
    }
    const name = cleanSeatName(metadata?.name) || "Player";
    const r = this.room;
    let seat = r.seats.find((s) => s.pid === pid);
    if (!seat) {
      if (r.seats.filter((s) => !s.left).length >= MAX_PLAYERS) {
        this.net.dismiss(id, { type: "full" });
        return;
      }
      seat = { pid, name, host: false, total: 0, solved: 0, left: false };
      r.seats.push(seat);
    }
    seat.left = false;
    seat.name = name;

    // The same player on a new link: forget the old one.
    for (const [peer, p] of this.peers) {
      if (p === pid && peer !== id) {
        this.peers.delete(peer);
        this.heard.delete(peer);
      }
    }
    this.peers.set(id, pid);
    this.heard.set(id, Date.now());

    // Arriving mid-turn: they play the rest of it, on the same clock.
    if (r.phase === "turn" && !r.turn.events[pid]) r.turn.events[pid] = [];
    this.changed();
  }

  onAway(id) {
    if (!this.peers.delete(id)) return;
    this.heard.delete(id);
    this.changed();
  }

  onMessage(from, message) {
    const pid = this.peers.get(from);
    if (!pid) return;
    this.heard.set(from, Date.now());
    switch (message.type) {
      case "hello":
        if (message.v !== PROTOCOL_VERSION) this.net.dismiss(from, { type: "outdated" });
        else this.net.send(this.snapshotFor(pid), from);
        break;
      case "input":
        this.act(pid, message);
        break;
      case "bye":
        this.onBye(from, pid);
        break;
      default:
        // ping, and anything from a newer build: ignored, never thrown on.
        break;
    }
  }

  // Leaving on purpose. Before a game their seat is freed; during one it is
  // kept for the standings, marked left.
  onBye(from, pid) {
    this.peers.delete(from);
    this.heard.delete(from);
    this.net?.dropId(from);
    const r = this.room;
    if (r.phase === "lobby") r.seats = r.seats.filter((s) => s.pid !== pid);
    else {
      const seat = this.seat(pid);
      if (seat) seat.left = true;
    }
    this.changed();
  }

  present() {
    return new Set([HOST_PID, ...this.peers.values()]);
  }

  seat(pid) {
    return this.room.seats.find((s) => s.pid === pid);
  }

  station() {
    return this.room.turn ? this.stations.byName.get(this.room.turn.station.toLowerCase()) : null;
  }

  /* ---- what the host does ---- */

  setSettings(changes) {
    const r = this.room;
    if (r.phase !== "lobby") return;
    const s = { ...r.settings };
    if ("stations" in changes) {
      const n = Math.floor(Number(changes.stations));
      if (Number.isFinite(n)) s.stations = Math.max(1, Math.min(this.stations.rows.length, n));
    }
    if ("difficulty" in changes) s.difficulty = cleanDifficulty(changes.difficulty);
    if ("turn" in changes) s.turn = PARTY_TURNS.includes(cleanTurn(changes.turn)) ? cleanTurn(changes.turn) : s.turn;
    r.settings = s;
    this.changed();
  }

  canStart() {
    return this.room.phase === "lobby" && this.present().size >= 2;
  }

  start() {
    if (!this.canStart()) return;
    const r = this.room;
    const now = Date.now();
    r.seats = r.seats.filter((s) => !s.left);
    for (const s of r.seats) {
      s.total = 0;
      s.solved = 0;
    }
    r.order = shuffle(this.stations.rows, randomInt)
      .slice(0, r.settings.stations)
      .map((s) => s.name_en);
    r.index = 0;
    r.history = [];
    r.roster = r.seats.map((s) => ({ pid: s.pid, name: s.name }));
    r.started_at = new Date(now).toISOString();
    r.replay_url = null;
    r.turn = null;
    r.phase = "ready";
    r.ends_at = now + READY_MS;
    this.changed();
  }

  // Straight on from a station's result.
  skip() {
    if (this.room.phase === "result") this.next(Date.now());
  }

  playAgain() {
    const r = this.room;
    if (r.phase !== "final") return;
    r.seats = r.seats.filter((s) => !s.left);
    r.phase = "lobby";
    r.turn = null;
    r.index = -1;
    r.ends_at = null;
    this.changed();
  }

  kick(pid) {
    if (pid === HOST_PID) return;
    for (const [peer, p] of [...this.peers]) {
      if (p !== pid) continue;
      this.net?.dismiss(peer, { type: "kicked" });
      this.peers.delete(peer);
      this.heard.delete(peer);
    }
    const r = this.room;
    r.seats = r.seats.filter((s) => s.pid !== pid);
    if (r.turn) delete r.turn.events[pid];
    this.changed();
  }

  setReplayUrl(url) {
    this.room.replay_url = url;
    this.changed();
  }

  /* ---- a player's move, the host's own or a guest's ---- */

  act(pid, input) {
    const seat = this.seat(pid);
    if (!seat || !input || typeof input.action !== "string") return;
    const r = this.room;

    if (input.action === "name") {
      const name = cleanSeatName(input.name);
      if (name) {
        seat.name = name;
        this.changed();
      }
      return;
    }
    if (input.action === "replay") {
      // A guest asking for the replay link: the host's page makes it.
      if (r.phase === "final" && !r.replay_url) this.dispatchEvent(new CustomEvent("replay-wanted"));
      return;
    }

    const turn = r.turn;
    const events = turn?.events[pid];
    if (r.phase !== "turn" || !events) return;
    const now = Date.now();
    const station = this.station();
    const elapsed = Math.min(now - turn.started_at, turnMs(r.settings.turn));
    const s = turnState(turn.station, r.settings, events, turnMs(r.settings.turn), elapsed);
    if (s.done) return;
    if (events.length >= MAX_EVENTS && input.action !== "giveup") {
      this.say(pid, "That is enough for one station. Give up to see it.", "error");
      return;
    }

    if (input.action === "guess") {
      const text = cleanText(input.text, 64);
      if (!text) return;
      events.push([elapsed, "g", text]);
      const after = turnState(turn.station, r.settings, events, turnMs(r.settings.turn), elapsed);
      if (after.done) this.say(pid, `Solved for ${after.points} points.`, "ok");
      else this.say(pid, `Not ${text}. ${WRONG_GUESS_COST} points off.`, "miss");
    } else if (input.action === "hint") {
      const next = nextHint(s.tier, s.revealed, turn.station, r.settings.difficulty);
      if (!next || !station) return;
      events.push([elapsed, "h", next.tier]);
      this.say(pid, `${HINT_LABELS[next.tier]} hint, ${next.penalty} points off.`, "");
    } else if (input.action === "giveup") {
      events.push([elapsed, "x"]);
      this.say(pid, "You gave up on this one.", "");
    } else {
      return;
    }
    this.changed();
    this.maybeEndTurn(now);
  }

  say(pid, text, tone) {
    const fb = this.room.turn.feedback;
    fb[pid] = { id: (fb[pid]?.id ?? 0) + 1, text, tone };
  }

  /* ---- the clock ---- */

  beginTurn(now) {
    const r = this.room;
    const name = r.order[r.index];
    r.turn = {
      station: name,
      started_at: now,
      order: shuffle(letterPositions(name), randomInt),
      events: Object.fromEntries(r.seats.filter((s) => !s.left).map((s) => [s.pid, []])),
      feedback: {},
      end: null,
    };
    for (const s of r.seats) if (!r.roster.some((p) => p.pid === s.pid)) r.roster.push({ pid: s.pid, name: s.name });
    r.phase = "turn";
    r.ends_at = now + turnMs(r.settings.turn);
    this.changed();
  }

  // Over when everybody still here has solved it or given up, or at the
  // time limit. Somebody who dropped out does not hold the rest up.
  maybeEndTurn(now) {
    const r = this.room;
    if (r.phase !== "turn") return;
    const present = this.present();
    const limit = turnMs(r.settings.turn);
    const elapsed = now - r.turn.started_at;
    const waiting = Object.entries(r.turn.events).some(
      ([pid, events]) => present.has(pid) && !turnState(r.turn.station, r.settings, events, limit, elapsed).done
    );
    if (!waiting || elapsed >= limit) this.endTurn(now);
  }

  endTurn(now) {
    const r = this.room;
    const turn = r.turn;
    const end = Math.min(now - turn.started_at, turnMs(r.settings.turn));
    turn.end = end;
    turn.points = {};
    for (const [pid, events] of Object.entries(turn.events)) {
      const s = turnState(turn.station, r.settings, events, end, end);
      turn.points[pid] = s.points;
      const seat = this.seat(pid);
      if (seat) {
        seat.total += s.points;
        if (s.done?.by === "solved") seat.solved += 1;
      }
    }
    r.history.push({ station: turn.station, order: turn.order, end, events: structuredClone(turn.events) });
    r.phase = "result";
    r.ends_at = now + RESULT_MS;
    this.changed();
  }

  next(now) {
    const r = this.room;
    if (r.index + 1 < r.order.length) {
      r.index += 1;
      r.phase = "ready";
      r.ends_at = now + READY_MS;
    } else {
      r.phase = "final";
      r.ends_at = null;
    }
    this.changed();
  }

  tick() {
    const now = Date.now();
    const r = this.room;

    for (const [peer, at] of [...this.heard]) {
      if (now - at <= SILENT_MS) continue;
      this.net?.dropId(peer);
      this.onAway(peer);
    }

    if (r.phase === "ready" && now >= r.ends_at) this.beginTurn(now);
    else if (r.phase === "turn") this.maybeEndTurn(now);
    else if (r.phase === "result" && now >= r.ends_at) this.next(now);

    this.broadcast();
    if (this.dirty && now - this.savedAt >= SAVE_EVERY_MS) this.save(now);
  }

  changed() {
    this.dirty = true;
  }

  save(now) {
    this.dirty = false;
    this.savedAt = now;
    session.set(ROOM_KEY, JSON.stringify({ code: this.code, room: this.room }));
  }

  broadcast() {
    for (const [peer, pid] of this.peers) this.net?.send(this.snapshotFor(pid), peer);
    this.dispatchEvent(new CustomEvent("state", { detail: this.snapshotFor(HOST_PID) }));
  }

  /* ---- what each player sees ---- */

  snapshotFor(pid) {
    const now = Date.now();
    const r = this.room;
    const present = this.present();
    const over = r.phase === "result" || r.phase === "final";
    const turn = r.turn;
    const limit = turnMs(r.settings.turn);
    const elapsed = turn ? Math.min(now - turn.started_at, turn.end ?? limit) : 0;

    // Two people called Sam become Sam and Sam 2.
    const used = new Map();
    const names = new Map(
      r.seats.map((s) => {
        const n = (used.get(s.name.toLowerCase()) ?? 0) + 1;
        used.set(s.name.toLowerCase(), n);
        return [s.pid, n > 1 ? `${s.name} ${n}` : s.name];
      })
    );

    const players = r.seats.map((s) => {
      const events = turn?.events[s.pid];
      let status = null;
      if (events && (r.phase === "turn" || r.phase === "result")) {
        const st = turnState(turn.station, r.settings, events, turn.end ?? limit, elapsed);
        status = st.done?.by === "solved" ? "solved" : st.done ? "gave_up" : over ? "out" : "playing";
      }
      return {
        pid: s.pid,
        name: names.get(s.pid),
        host: s.host,
        here: present.has(s.pid),
        left: s.left,
        total: s.total,
        solved: s.solved,
        game: gameScore(s.total, r.order.length || r.settings.stations),
        status,
        points: r.phase === "result" && turn.points ? (turn.points[s.pid] ?? null) : null,
      };
    });

    const out = {
      type: "state",
      v: PROTOCOL_VERSION,
      phase: r.phase,
      you: pid,
      is_host: pid === HOST_PID,
      code: pid === HOST_PID ? this.code : null,
      settings: r.settings,
      max_stations: this.stations.rows.length,
      length_multiplier: lengthMultiplier(r.order.length || r.settings.stations),
      index: r.index,
      count: r.order.length,
      left_ms: r.ends_at ? Math.max(0, r.ends_at - now) : null,
      phase_ms: { ready: READY_MS, turn: limit, result: RESULT_MS }[r.phase] ?? null,
      players,
      round: null,
      answer: null,
      replay_url: r.phase === "final" ? r.replay_url : null,
    };

    const events = turn?.events[pid];
    if (turn && events && (r.phase === "turn" || r.phase === "result")) {
      const station = this.station();
      const name = turn.station;
      const s = turnState(name, r.settings, events, turn.end ?? limit, elapsed);
      const finished = Boolean(s.done) || over;
      out.round = {
        id: r.index,
        mask: maskOf(name, turn.order.slice(0, s.revealed), s.done?.by === "solved" || over),
        length: letterPositions(name).length,
        hints: station ? hintsFor(station, s.tier) : { colors: [] },
        score: s.done || over ? s.points : s.base,
        solved: s.done?.by === "solved",
        gave_up: s.done?.by === "gave_up",
        next_hint: finished ? null : nextHint(s.tier, s.revealed, name, r.settings.difficulty),
        next_reveal_in: finished ? null : nextRevealIn(name, r.settings.difficulty, elapsed, s.bought, limit),
        letters_left: maxReveals(name, r.settings.difficulty) - s.revealed,
        scoring: s.done?.by === "solved" ? { base: s.base, ...multipliers(r.settings, s.done.t), points: s.points } : null,
        feedback: turn.feedback[pid] ?? null,
      };
    }
    if (turn && over && r.phase === "result") {
      const station = this.station();
      out.answer = {
        name_en: turn.station,
        name_zh: station?.name_zh ?? null,
        name_ta: station?.name_ta ?? null,
        codes: station?.codes ?? [],
      };
    }
    return out;
  }

  // The game as a replay, in js/replay-format.js's format: everybody who
  // played any station, in the order they first did.
  replay() {
    const r = this.room;
    const roster = r.roster.map((p) => ({ pid: p.pid, name: this.seat(p.pid)?.name ?? p.name }));
    return {
      v: 1,
      kind: "party",
      at: r.started_at,
      settings: { difficulty: r.settings.difficulty, turn: r.settings.turn },
      players: roster.map((p) => p.name),
      turns: r.history.map((h) => ({
        station: h.station,
        order: h.order,
        end: h.end,
        events: roster.map((p) => h.events[p.pid] ?? null),
      })),
    };
  }
}

