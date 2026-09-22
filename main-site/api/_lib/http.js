// Request plumbing shared by every endpoint: auth, rate limits, replies.

import { createHash, timingSafeEqual } from "node:crypto";
import { configured, rpc, UpstreamError } from "./supabase.js";

export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message ?? code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const digest = (value) => createHash("sha256").update(value).digest();

// Bots send BOT_API_TOKEN as a bearer token. A wrong token is refused rather
// than treated as a browser, so a misconfigured bot fails loudly.
export function isBot(req) {
  const header = req.headers.authorization ?? "";
  if (!header) return false;
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const expected = process.env.BOT_API_TOKEN ?? "";
  if (!token || !expected || !timingSafeEqual(digest(token), digest(expected))) {
    throw new HttpError(401, "bad_token");
  }
  return true;
}

// Vercel sets both from the connecting address; neither can be forged from
// outside. The first x-forwarded-for entry is the fallback.
export function clientIp(req) {
  return (
    req.headers["x-real-ip"] ||
    String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown"
  );
}

// Per IP, per action, fixed window. Bots are exempt: every Telegram player
// arrives from the one VPS address. Fails open, since a broken limiter
// should not take the game down with it.
export async function rateLimit(req, bot, action, max, windowSeconds = 60) {
  if (bot) return;
  try {
    const allowed = await rpc("mrtguessr_hit", {
      p_bucket: `${action}:${clientIp(req)}`,
      p_window_seconds: windowSeconds,
      p_max: max,
    });
    if (allowed === false) throw new HttpError(429, "rate_limited", "Slow down a little and try again.");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    console.warn("rate limit check failed, allowing:", err.message);
  }
}

// Browsers generate a random key once; bots use "tg:<user id>" or
// "dc:<user id>". Only a bot may use the prefixed form.
export function clientKey(value, bot) {
  const key = typeof value === "string" ? value.trim() : "";
  const ok = bot ? /^(tg|dc):\d{1,20}$/.test(key) : /^[A-Za-z0-9_-]{16,64}$/.test(key);
  if (!ok) throw new HttpError(400, "bad_client_key");
  return key;
}

export function roundId(value) {
  const id = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new HttpError(400, "bad_round_id");
  }
  return id;
}

function body(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try {
      return JSON.parse(req.body);
    } catch {
      throw new HttpError(400, "bad_json");
    }
  }
  return {};
}

// Wraps a handler: method check, no caching of anything personal, and one
// shape for every error.
export function endpoint(method, handler) {
  return async (req, res) => {
    if (req.method !== method) {
      res.setHeader("Allow", method);
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }
    if (!configured()) {
      res.status(503).json({ error: "not_configured" });
      return;
    }
    if (method !== "GET") res.setHeader("Cache-Control", "no-store");

    try {
      const bot = isBot(req);
      const result = await handler({ req, res, bot, body: body(req) });
      if (!res.headersSent) res.status(200).json(result);
    } catch (err) {
      if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.code, message: err.message !== err.code ? err.message : undefined, ...err.extra });
        return;
      }
      console.error(err);
      const upstream = err instanceof UpstreamError || err.name === "AbortError";
      res.status(upstream ? 502 : 500).json({ error: upstream ? "upstream" : "server" });
    }
  };
}
