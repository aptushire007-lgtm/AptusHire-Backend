// Ensemble consensus math (BUILD-PLAN Phase 2.1). Agreement is computed IN CODE
// by field-level comparison — these tests pin that arithmetic with hand-computed
// values, then verify generateJSONEnsemble's wiring over replay fixtures with the
// network banned.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { computeConsensus } = require("../../utils/ensemble");
const llm = require("../../services/llmService");

// ---- Pure math ---------------------------------------------------------------

test("unanimous samples: agreement 1, no disagreements, consensus equals the sample", () => {
  const s = { verdict: "pass", years: 4, skills: ["node", "sql"] };
  const r = computeConsensus([s, { ...s }, { ...s }]);
  assert.equal(r.agreement, 1);
  assert.equal(r.unanimous, true);
  assert.deepEqual(r.disagreements, []);
  assert.deepEqual(r.consensus, s);
});

test("2-vs-1 split on one field: modal value wins, agreement is the field mean", () => {
  const r = computeConsensus([
    { a: 1, b: "x" },
    { a: 1, b: "x" },
    { a: 1, b: "y" },
  ]);
  assert.deepEqual(r.consensus, { a: 1, b: "x" });
  // a agrees 3/3, b agrees 2/3 → mean (1 + 2/3) / 2 = 5/6
  assert.ok(Math.abs(r.agreement - 5 / 6) < 1e-12);
  assert.equal(r.unanimous, false);
  assert.deepEqual(r.disagreements, [{ field: "b", values: [{ value: "x", count: 2 }, { value: "y", count: 1 }] }]);
  assert.equal(r.fieldAgreement.b, 2 / 3);
});

test("ties break to the earliest sample (deterministic, order-stable)", () => {
  const r = computeConsensus([{ v: "first" }, { v: "second" }]);
  assert.equal(r.consensus.v, "first");
  assert.equal(r.agreement, 0.5);
  assert.equal(r.disagreements.length, 1);
});

test("object key order does not create false disagreement", () => {
  const r = computeConsensus([
    { a: 1, nested: { x: 1, y: 2 } },
    { nested: { y: 2, x: 1 }, a: 1 },
  ]);
  assert.equal(r.unanimous, true);
  assert.equal(r.agreement, 1);
});

test("a field missing from one sample is a disagreement, not silently filled", () => {
  const r = computeConsensus([{ a: 1 }, { a: 1, b: 2 }]);
  assert.equal(r.fieldAgreement.a, 1);
  assert.equal(r.fieldAgreement.b, 0.5);
  assert.equal(r.disagreements.length, 1);
  assert.equal(r.disagreements[0].field, "b");
});

test("non-object samples compare as a single whole value", () => {
  const r = computeConsensus(["a", "a", "b"]);
  assert.equal(r.consensus, "a");
  assert.ok(Math.abs(r.agreement - 2 / 3) < 1e-12);
  assert.equal(r.disagreements[0].field, "$");
});

test("empty samples array throws", () => {
  assert.throws(() => computeConsensus([]));
});

// ---- generateJSONEnsemble wiring (replay fixtures, zero network) -------------

const ENV_KEYS = ["LLM_REPLAY", "LLM_RECORD", "LLM_FIXTURES_DIR", "OPENROUTER_API_KEY", "LLM_ENSEMBLE_ENABLED", "LLM_ENSEMBLE_MAX_N"];
let savedEnv;
let tmpDir;
let realFetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-ensemble-"));
  process.env.LLM_FIXTURES_DIR = tmpDir;
  process.env.LLM_REPLAY = "1";
  delete process.env.LLM_RECORD;
  delete process.env.OPENROUTER_API_KEY;
  realFetch = global.fetch;
  global.fetch = () => {
    throw new Error("NETWORK CALL ATTEMPTED — ensemble tests must run entirely from fixtures");
  };
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  global.fetch = realFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BASE = { system: "You are a test.", prompt: "Assess the claim.", model: "test/model-1" };
const perturb = (p, i) => `${p} [variant ${i}]`;

function writeFixture(prompt, data, costCents = 0.01) {
  const shape = { model: "test/model-1", system: BASE.system, prompt, schema: null, maxTokens: 768, temperature: 0, promptVersion: null };
  const key = llm.requestKey(shape);
  fs.writeFileSync(
    path.join(tmpDir, `${key}.json`),
    JSON.stringify({ key, request: shape, response: { data, usage: { promptTokens: 10, completionTokens: 5, costCents }, model: "test/model-1" } })
  );
}

test("ensemble n=3: samples all replayed, consensus + agreement + summed usage", async () => {
  process.env.LLM_ENSEMBLE_ENABLED = "1";
  writeFixture(BASE.prompt, { verdict: "pass", years: 4 });
  writeFixture(perturb(BASE.prompt, 1), { verdict: "pass", years: 4 });
  writeFixture(perturb(BASE.prompt, 2), { verdict: "fail", years: 4 });

  const r = await llm.generateJSONEnsemble({ ...BASE, n: 3, perturb });
  assert.equal(r.n, 3);
  assert.equal(r.samples.length, 3);
  assert.equal(r.failures, 0);
  assert.deepEqual(r.consensus, { verdict: "pass", years: 4 });
  // verdict 2/3, years 3/3 → (2/3 + 1) / 2 = 5/6
  assert.ok(Math.abs(r.agreement - 5 / 6) < 1e-12);
  assert.equal(r.unanimous, false);
  assert.equal(r.disagreements.length, 1);
  assert.equal(r.disagreements[0].field, "verdict");
  assert.equal(r.usage.promptTokens, 30);
  assert.equal(r.usage.completionTokens, 15);
  assert.ok(Math.abs(r.usage.costCents - 0.03) < 1e-9);
});

test("ensemble is gated: without LLM_ENSEMBLE_ENABLED, n collapses to 1", async () => {
  delete process.env.LLM_ENSEMBLE_ENABLED;
  writeFixture(BASE.prompt, { verdict: "pass" });
  // Only the unperturbed fixture exists — if the gate failed, samples 2..3 would
  // throw LLM_REPLAY_MISS.
  const r = await llm.generateJSONEnsemble({ ...BASE, n: 3, perturb });
  assert.equal(r.n, 1);
  assert.equal(r.requested, 3);
  assert.equal(r.samples.length, 1);
  assert.equal(r.agreement, 1);
});

test("n is clamped to LLM_ENSEMBLE_MAX_N no matter what the caller asks for", async () => {
  process.env.LLM_ENSEMBLE_ENABLED = "1";
  process.env.LLM_ENSEMBLE_MAX_N = "2";
  writeFixture(BASE.prompt, { verdict: "pass" });
  writeFixture(perturb(BASE.prompt, 1), { verdict: "pass" });
  const r = await llm.generateJSONEnsemble({ ...BASE, n: 99, perturb });
  assert.equal(r.n, 2);
  assert.equal(r.requested, 99);
});
