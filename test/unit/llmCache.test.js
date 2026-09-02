// Deterministic LLM response cache (BUILD-PLAN Phase 2.2). Acceptance gate:
// same input ×5 through the cache returns byte-identical output — and exactly
// one live call. Also pins the invalidation rules (promptVersion in the key,
// no caching of sampled temperature>0 output) and LRU behaviour.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const llmCache = require("../../services/llmCache");
const llm = require("../../services/llmService");

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "REDIS_URL",
  "LLM_CACHE_ENABLED",
  "LLM_CACHE_TTL_S",
  "LLM_CACHE_MAX_ENTRIES",
  "LLM_REPLAY",
  "LLM_RECORD",
  "LLM_MAX_RETRIES",
];
let savedEnv;
let realFetch;
let fetchCalls;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.REDIS_URL; // force the in-process LRU path
  delete process.env.LLM_REPLAY;
  delete process.env.LLM_RECORD;
  delete process.env.LLM_CACHE_ENABLED;
  delete process.env.LLM_CACHE_TTL_S;
  delete process.env.LLM_CACHE_MAX_ENTRIES;
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  process.env.LLM_MAX_RETRIES = "0";
  llmCache._clearForTests();
  llm._resetBreakerForTests();
  realFetch = global.fetch;
  fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"verdict":"pass","score_basis":["a","b"]}' } }],
        usage: { prompt_tokens: 20, completion_tokens: 7, cost: 0.0003 },
        model: "test/model-1",
      }),
    };
  };
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  global.fetch = realFetch;
  llmCache._clearForTests();
});

const REQ = { system: "You are a test.", prompt: "Assess.", model: "test/model-1", promptVersion: "v1" };

test("ACCEPTANCE GATE: same input ×5 → one live call, byte-identical data every time", async () => {
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await llm.generateJSON(REQ));

  assert.equal(fetchCalls, 1, "only the first call may touch the provider");
  const first = JSON.stringify(results[0].data);
  for (const r of results) assert.equal(JSON.stringify(r.data), first, "cached data must be byte-identical");

  // Provenance is explicit: the live call is not flagged, every hit is.
  assert.equal(results[0].cached, undefined);
  for (const r of results.slice(1)) assert.equal(r.cached, true);

  // A hit spends nothing — original usage must not be double-counted in metering.
  assert.equal(results[0].usage.promptTokens, 20);
  for (const r of results.slice(1)) {
    assert.deepEqual(r.usage, { promptTokens: 0, completionTokens: 0, costCents: 0 });
  }
});

test("promptVersion is part of the key: bumping it invalidates the cache", async () => {
  await llm.generateJSON(REQ);
  await llm.generateJSON(REQ);
  assert.equal(fetchCalls, 1);
  await llm.generateJSON({ ...REQ, promptVersion: "v2" });
  assert.equal(fetchCalls, 2, "a prompt edit must never serve the stale decision");
});

test("model id is part of the key", async () => {
  await llm.generateJSON(REQ);
  await llm.generateJSON({ ...REQ, model: "test/model-2" });
  assert.equal(fetchCalls, 2);
});

test("temperature > 0 is never cached (sampling variance must stay real)", async () => {
  await llm.generateJSON({ ...REQ, temperature: 0.7 });
  await llm.generateJSON({ ...REQ, temperature: 0.7 });
  assert.equal(fetchCalls, 2);
});

test("LLM_CACHE_ENABLED=false rolls the cache back cleanly", async () => {
  process.env.LLM_CACHE_ENABLED = "false";
  await llm.generateJSON(REQ);
  await llm.generateJSON(REQ);
  assert.equal(fetchCalls, 2);
});

test("record mode always makes the live call (fixtures need real responses)", async () => {
  const fs = require("fs");
  const os = require("os");
  const path = require("path");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-cache-record-"));
  process.env.LLM_FIXTURES_DIR = tmpDir;
  try {
    await llm.generateJSON(REQ); // live, cached
    process.env.LLM_RECORD = "1";
    await llm.generateJSON(REQ); // must NOT be served from cache
    assert.equal(fetchCalls, 2);
  } finally {
    delete process.env.LLM_RECORD;
    delete process.env.LLM_FIXTURES_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("LRU: least-recently-used entry is evicted at capacity, recency counts", async () => {
  process.env.LLM_CACHE_MAX_ENTRIES = "2";
  await llmCache.set("a", { data: 1 });
  await llmCache.set("b", { data: 2 });
  assert.deepEqual(await llmCache.get("a"), { data: 1 }); // touch a → b is now LRU
  await llmCache.set("c", { data: 3 }); // evicts b
  assert.deepEqual(await llmCache.get("a"), { data: 1 });
  assert.equal(await llmCache.get("b"), null);
  assert.deepEqual(await llmCache.get("c"), { data: 3 });
});

test("entries expire after the TTL", async () => {
  process.env.LLM_CACHE_TTL_S = "1";
  await llmCache.set("k", { data: "v" });
  assert.deepEqual(await llmCache.get("k"), { data: "v" });
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(await llmCache.get("k"), null);
});
