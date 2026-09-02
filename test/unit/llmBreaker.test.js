// Circuit breaker (BUILD-PLAN Phase 2.4). Acceptance gate: a dead provider opens
// the breaker and subsequent calls fail through to the deterministic fallback in
// well under 2 seconds, with the state visible on /metrics. Guardrail under test:
// breaker state must be observable, or an open breaker looks like "the AI got worse."

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const llm = require("../../services/llmService");
const metrics = require("../../utils/metrics");

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "REDIS_URL",
  "LLM_CACHE_ENABLED",
  "LLM_MAX_RETRIES",
  "LLM_BREAKER_THRESHOLD",
  "LLM_BREAKER_COOLDOWN_MS",
  "LLM_REPLAY",
  "LLM_RECORD",
];
let savedEnv;
let realFetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env.REDIS_URL;
  delete process.env.LLM_REPLAY;
  delete process.env.LLM_RECORD;
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  process.env.LLM_CACHE_ENABLED = "false"; // isolate breaker behaviour from the cache
  process.env.LLM_MAX_RETRIES = "0"; // 1 attempt per call → deterministic failure counting
  process.env.LLM_BREAKER_THRESHOLD = "3";
  process.env.LLM_BREAKER_COOLDOWN_MS = "60000";
  llm._resetBreakerForTests();
  realFetch = global.fetch;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  global.fetch = realFetch;
  llm._resetBreakerForTests();
});

const REQ = { system: "You are a test.", prompt: "Hello.", model: "test/model-1" };

let fetchCalls;
function deadProvider() {
  fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    throw new Error("connect ECONNREFUSED (provider is down)");
  };
}
function healthyProvider() {
  fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, cost: 0.0001 },
        model: "test/model-1",
      }),
    };
  };
}

test("ACCEPTANCE GATE: dead provider opens the breaker; next call fails fast (<2s) with a metric", async () => {
  deadProvider();
  for (let i = 0; i < 3; i++) {
    await assert.rejects(llm.generateJSON(REQ), /provider is down|LLM request failed/);
  }
  assert.equal(llm.breakerState(), "open");
  assert.equal(fetchCalls, 3);

  const t0 = Date.now();
  await assert.rejects(llm.generateJSON(REQ), (err) => err.code === "LLM_BREAKER_OPEN");
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 2000, `open-breaker fallback took ${elapsed}ms — must be <2000ms`);
  assert.equal(fetchCalls, 3, "an open breaker must not touch the provider at all");

  const exposition = metrics.render();
  assert.match(exposition, /llm_breaker_state 2/, "open state must be visible on /metrics");
  assert.match(exposition, /llm_breaker_opens_total 1/);
});

test("after the cooldown the breaker goes half-open; a success closes it", async () => {
  process.env.LLM_BREAKER_THRESHOLD = "1";
  process.env.LLM_BREAKER_COOLDOWN_MS = "50";
  deadProvider();
  await assert.rejects(llm.generateJSON(REQ));
  assert.equal(llm.breakerState(), "open");

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(llm.breakerState(), "half_open");

  healthyProvider();
  const result = await llm.generateJSON(REQ);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(llm.breakerState(), "closed");
  assert.match(metrics.render(), /llm_breaker_state 0/);
});

test("a failure while half-open re-opens immediately (no need to re-accumulate the threshold)", async () => {
  process.env.LLM_BREAKER_COOLDOWN_MS = "50";
  deadProvider();
  for (let i = 0; i < 3; i++) await assert.rejects(llm.generateJSON(REQ));
  assert.equal(llm.breakerState(), "open");

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(llm.breakerState(), "half_open");

  await assert.rejects(llm.generateJSON(REQ), /provider is down|LLM request failed/);
  assert.equal(llm.breakerState(), "open");
});

test("non-retryable 4xx responses are our bug, not provider sickness — they never trip the breaker", async () => {
  process.env.LLM_BREAKER_THRESHOLD = "1";
  fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return { ok: false, status: 400, text: async () => "bad request", headers: { get: () => null } };
  };
  await assert.rejects(llm.generateJSON(REQ), /400/);
  await assert.rejects(llm.generateJSON(REQ), /400/);
  assert.equal(llm.breakerState(), "closed");
  assert.equal(fetchCalls, 2, "calls must keep reaching the provider — the breaker stayed closed");
});
