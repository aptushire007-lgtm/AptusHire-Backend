// Deterministic LLM response cache (BUILD-PLAN Phase 2.2).
//
// Key: sha256 over the FULL request shape — model, promptVersion, system, prompt,
// schema, maxTokens, temperature (computed by llmService.requestKey, same hash the
// record/replay fixtures use). Because promptVersion and model id are inside the
// key, a prompt edit or model swap invalidates cleanly instead of serving stale
// decisions (Phase 2 guardrail).
//
// What this buys: re-scoring an unchanged résumé returns the byte-identical
// result (reproducibility for free), ATS re-runs stop double-spending, and the
// eval harness gets cheap. Only temperature-0 requests are cached — a non-zero
// temperature is a request for sampling variance, and caching it would lie.
//
// Store: Redis when REDIS_URL is configured (shared across instances, TTL-bound),
// in-process LRU otherwise. Cache failures degrade to a miss — never break the call.
// Rollback: LLM_CACHE_ENABLED=false.

const { getRedisConnection } = require("../config/redis");

const PREFIX = "llmcache:";

function enabled() {
  const v = process.env.LLM_CACHE_ENABLED;
  return v !== "false" && v !== "0";
}

function ttlSeconds() {
  return Number(process.env.LLM_CACHE_TTL_S) || 7 * 24 * 3600;
}

function maxEntries() {
  return Number(process.env.LLM_CACHE_MAX_ENTRIES) || 500;
}

// --- In-process LRU (fallback when Redis is absent) --------------------------
// Map preserves insertion order; delete+reinsert on read makes the first key the
// least-recently-used, so overflow eviction is O(1).
const lru = new Map(); // key -> { json, expiresAt }

function lruGet(key) {
  const entry = lru.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    lru.delete(key);
    return null;
  }
  lru.delete(key);
  lru.set(key, entry);
  return entry.json;
}

function lruSet(key, json) {
  if (lru.has(key)) lru.delete(key);
  lru.set(key, { json, expiresAt: Date.now() + ttlSeconds() * 1000 });
  while (lru.size > maxEntries()) lru.delete(lru.keys().next().value);
}

// --- Public API ---------------------------------------------------------------

/** Cached result object for this request key, or null on miss/disabled/error. */
async function get(key) {
  if (!enabled()) return null;
  const redis = getRedisConnection();
  let json = null;
  if (redis) {
    try {
      json = await redis.get(PREFIX + key);
    } catch (err) {
      console.warn("[llmCache] redis get failed, treating as miss:", err.message);
    }
  } else {
    json = lruGet(key);
  }
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null; // corrupted entry — miss, and the fresh set below overwrites it
  }
}

/** Store a successful result. Best-effort: a store failure is logged, never thrown. */
async function set(key, result) {
  if (!enabled()) return;
  const json = JSON.stringify(result);
  const redis = getRedisConnection();
  if (redis) {
    try {
      await redis.set(PREFIX + key, json, "EX", ttlSeconds());
    } catch (err) {
      console.warn("[llmCache] redis set failed:", err.message);
    }
  } else {
    lruSet(key, json);
  }
}

// Test hook: reset the in-process store between test cases.
function _clearForTests() {
  lru.clear();
}

module.exports = { enabled, get, set, _clearForTests };
