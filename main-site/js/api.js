// The game API. Every rule lives on the server; this only carries requests.

const KEY_STORAGE = "mrtguessr.clientKey";

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

// A random id tying this browser's requests to its own rounds. Not an
// identity: it grants nothing and is never shown.
function makeKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let memoryKey = null;

export function clientKey() {
  try {
    let key = localStorage.getItem(KEY_STORAGE);
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(key ?? "")) {
      key = makeKey();
      localStorage.setItem(KEY_STORAGE, key);
    }
    return key;
  } catch {
    // Storage blocked: rounds still work for this page view.
    memoryKey ??= makeKey();
    return memoryKey;
  }
}

async function call(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "offline", "Rounds need a connection.");
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    // An HTML error page from the platform, not the API.
  }
  if (!response.ok) {
    throw new ApiError(response.status, data?.error ?? "server", data?.message);
  }
  return data;
}

const round = (path, roundId, extra = {}) =>
  call("POST", `/api/round/${path}`, { round_id: roundId, client_key: clientKey(), ...extra });

export const api = {
  newRound: () => call("POST", "/api/round/new", { client_key: clientKey() }),
  state: (roundId) => round("state", roundId),
  hint: (roundId) => round("hint", roundId),
  giveUp: (roundId) => round("giveup", roundId),
  guess: (roundId, guess) => round("guess", roundId, { guess }),
  submit: (roundId, name) => call("POST", "/api/leaderboard/submit", { round_id: roundId, name }),
  leaderboard: (board) => call("GET", `/api/leaderboard?board=${encodeURIComponent(board)}`),
};
