// Credit-exhaustion handling.
//
// A 402 is the one provider failure a human — not a retry — has to clear, and
// the one most likely to be misread as a fault in the candidate's own document.
// These gates prove the two properties that stop that misreading:
//
//   - It is NAMED, on both routes it can arrive by (HTTP status and 200 body),
//     so every caller can report the real cause instead of a generic failure.
//   - It LATCHES, so a dead account is not re-billed once per application, and
//     un-latches on its own once the account is topped up — no restart, and no
//     alert storm either, because the outage's start timestamp is stable.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const llm = require("../../services/llmService");
const metrics = require("../../utils/metrics");

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "REDIS_URL",
  "LLM_CACHE_ENABLED",
  "LLM_MAX_RETRIES",
  "LLM_NO_CREDITS_COOLDOWN_MS",
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
  process.env.LLM_CACHE_ENABLED = "false";
  process.env.LLM_MAX_RETRIES = "2"; // deliberately >0: a 402 must not retry anyway
  process.env.LLM_NO_CREDITS_COOLDOWN_MS = "60000";
  llm._resetBreakerForTests();
  llm._resetCreditsForTests();
  realFetch = global.fetch;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  global.fetch = realFetch;
  llm._resetBreakerForTests();
  llm._resetCreditsForTests();
});

const REQ = { system: "You are a test.", prompt: "Hello.", model: "test/model-1" };

let fetchCalls;

// The billing failure as an HTTP status.
function brokeProvider() {
  fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: false,
      status: 402,
      text: async () => '{"error":{"code":402,"message":"Insufficient credits"}}',
      headers: { get: () => null },
    };
  };
}

// The same failure mirrored into a 200 body, which OpenRouter also does.
function brokeProviderIn200Body() {
  fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      json: async () => ({ error: { code: 402, message: "Insufficient credits" } }),
    };
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

test("a 402 is coded LLM_NO_CREDITS and never retried", async () => {
  brokeProvider();
  await assert.rejects(llm.generateJSON(REQ), (err) => err.code === "LLM_NO_CREDITS");
  assert.equal(fetchCalls, 1, "retrying a billing outage burns money and time for a guaranteed refusal");
});

test("a 402 mirrored into a 200 body is coded identically — one outage, one name", async () => {
  brokeProviderIn200Body();
  await assert.rejects(llm.generateJSON(REQ), (err) => err.code === "LLM_NO_CREDITS");
});

// The counter is process-global and accumulates across tests, so read it rather
// than assuming a starting value.
function outageCount() {
  const m = metrics.render().match(/llm_credit_outages_total (\d+)/);
  return m ? Number(m[1]) : 0;
}

test("ACCEPTANCE GATE: the outage latches — later calls fail fast without touching the provider", async () => {
  const before = outageCount();
  brokeProvider();
  await assert.rejects(llm.generateJSON(REQ), (err) => err.code === "LLM_NO_CREDITS");
  assert.equal(fetchCalls, 1);

  // Fifty applications arriving during the outage must cost fifty *local*
  // refusals, not fifty round-trips to an account that cannot pay for them.
  for (let i = 0; i < 50; i++) {
    await assert.rejects(llm.generateJSON(REQ), (err) => err.code === "LLM_NO_CREDITS");
  }
  assert.equal(fetchCalls, 1, "a latched credit outage must not re-hit the provider");
  assert.match(metrics.render(), /llm_credits_exhausted 1/, "the outage must be visible on /metrics");
  assert.equal(outageCount(), before + 1, "51 refusals are ONE outage — a per-call counter would be unreadable");
});

test("the outage timestamp is stable across the whole outage, so operators are alerted once, not per call", async () => {
  brokeProvider();
  await assert.rejects(llm.generateJSON(REQ), (err) => err.code === "LLM_NO_CREDITS");
  const first = llm.creditOutageSince();
  assert.ok(first > 0);

  for (let i = 0; i < 5; i++) await assert.rejects(llm.generateJSON(REQ));
  assert.equal(llm.creditOutageSince(), first, "a stable timestamp is what makes alert dedupe possible");
});

test("after the cooldown one request probes for recovery; a top-up clears the latch with no restart", async () => {
  process.env.LLM_NO_CREDITS_COOLDOWN_MS = "50";
  brokeProvider();
  await assert.rejects(llm.generateJSON(REQ), (err) => err.code === "LLM_NO_CREDITS");
  assert.ok(llm.creditOutageSince() > 0);

  await new Promise((r) => setTimeout(r, 60));

  healthyProvider(); // the account was topped up between probes
  const result = await llm.generateJSON(REQ);
  assert.deepEqual(result.data, { ok: true });
  assert.equal(llm.creditOutageSince(), 0, "a settled response proves credit — the latch must clear itself");
  assert.match(metrics.render(), /llm_credits_exhausted 0/);
});

test("a probe that is still refused re-arms the latch instead of letting traffic through", async () => {
  process.env.LLM_NO_CREDITS_COOLDOWN_MS = "50";
  brokeProvider();
  await assert.rejects(llm.generateJSON(REQ), (err) => err.code === "LLM_NO_CREDITS");
  const started = llm.creditOutageSince();

  await new Promise((r) => setTimeout(r, 60));
  await assert.rejects(llm.generateJSON(REQ), (err) => err.code === "LLM_NO_CREDITS");
  assert.equal(fetchCalls, 2, "exactly one probe per cooldown");
  assert.equal(llm.creditOutageSince(), started, "a failed probe continues the same outage; it does not start a new one");

  await assert.rejects(llm.generateJSON(REQ), (err) => err.code === "LLM_NO_CREDITS");
  assert.equal(fetchCalls, 2, "and the latch is re-armed immediately after the failed probe");
});

test("a credit outage does not trip the circuit breaker — the two failures need different responses", async () => {
  brokeProvider();
  for (let i = 0; i < 10; i++) await assert.rejects(llm.generateJSON(REQ));
  assert.equal(llm.breakerState(), "closed", "an empty account is not a sick provider");
});

test("describeFailure names every code in human words and never leaks the enum", () => {
  assert.equal(llm.describeFailure({ code: "LLM_NO_CREDITS" }), "the AI provider account is out of credit");
  assert.equal(llm.describeFailure({ code: "LLM_TIMEOUT" }), "the AI provider timed out");

  // The point of the helper is that nothing reaches a human as a raw enum, so
  // the unknown and the missing cases must still produce a sentence.
  for (const err of [{ code: "SOMETHING_NEW" }, {}, null, undefined]) {
    const phrase = llm.describeFailure(err);
    assert.equal(phrase, "an unexpected AI provider error");
    assert.doesNotMatch(phrase, /[A-Z]{2,}_[A-Z]/, "a failure phrase must never contain a raw error code");
  }
});
