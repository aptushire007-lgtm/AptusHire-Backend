// Rate-limiter factory. Backs limits with Redis (shared across instances) when
// REDIS_URL is configured, else an in-memory store (single-instance dev fallback).
// Used to bound the cost-amplification / DoS surface on the AI interview endpoints —
// each answer submission is an LLM call, and the speed-test ships a 2 MB payload.

const rateLimit = require("express-rate-limit");
const { getRedisConnection } = require("../config/redis");
const logger = require("../utils/logger");

// NOTE: pin rate-limit-redis to the ^4.x line — 5.x/6.x require express-rate-limit >= 8.5,
// and this app is on ^7.5. Bumping one without the other silently breaks the store.
function makeStore(prefix) {
  const conn = getRedisConnection();
  if (!conn) return undefined; // fall back to express-rate-limit's default MemoryStore
  try {
    const mod = require("rate-limit-redis");
    const RedisStore = mod.default || mod.RedisStore || mod;
    return new RedisStore({ prefix, sendCommand: (...args) => conn.call(...args) });
  } catch (err) {
    // This runs at module load (limiters are constructed when routers are required), so a
    // packaging mistake here used to take the whole process down at boot with MODULE_NOT_FOUND.
    // Degrade to the per-process MemoryStore instead: limits stop being shared across
    // instances (weaker, but still enforced) rather than the API refusing to start.
    logger.error("rate-limit Redis store unavailable — falling back to in-memory limits", {
      prefix,
      err: { message: err.message },
    });
    return undefined;
  }
}

function createLimiter({ windowMs, max, prefix, keyGenerator, message }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store: makeStore(prefix),
    keyGenerator,
    message: { error: message || "Too many requests — please slow down." },
  });
}

// Key interview-portal limits by the session's candidate (falls back to IP) so one
// magic-link token can't amplify cost regardless of source IP. Also covers the
// assessment portal, whose auth middleware attaches req.assessmentSession.
function portalKey(req) {
  return String(req.interviewSession?.candidate || req.assessmentSession?.candidate || req.ip);
}

module.exports = { createLimiter, portalKey };
