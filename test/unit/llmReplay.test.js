// LLM record/replay (BUILD-PLAN Phase 1.6): CI must exercise the AI code paths
// with ZERO network calls. These tests stub fetch so any accidental network
// attempt is an immediate failure, not a silent spend.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const llm = require("../../services/llmService");

const ENV_KEYS = ["LLM_REPLAY", "LLM_RECORD", "LLM_FIXTURES_DIR", "OPENROUTER_API_KEY"];
let savedEnv;
let tmpDir;
let realFetch;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-fixtures-"));
  process.env.LLM_FIXTURES_DIR = tmpDir;
  delete process.env.LLM_REPLAY;
  delete process.env.LLM_RECORD;
  delete process.env.OPENROUTER_API_KEY;
  realFetch = global.fetch;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  global.fetch = realFetch;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function banNetwork() {
  global.fetch = () => {
    throw new Error("NETWORK CALL ATTEMPTED — replay mode must never touch the network");
  };
}

const REQ = { system: "You are a test.", prompt: "Say hi.", model: "test/model-1" };
// Must mirror llmService's internal request shape (defaults included).
// promptVersion joined the shape in Phase 2.6 — it is part of the fixture key so
// a prompt edit invalidates recordings the same way it invalidates the cache.
const REQ_SHAPE = { model: "test/model-1", system: "You are a test.", prompt: "Say hi.", schema: null, maxTokens: 768, temperature: 0, promptVersion: null };

test("requestKey is stable under object key order", () => {
  assert.equal(llm.requestKey({ a: 1, b: [1, 2] }), llm.requestKey({ b: [1, 2], a: 1 }));
  assert.notEqual(llm.requestKey({ a: 1 }), llm.requestKey({ a: 2 }));
});

test("replay serves the recorded response with zero network and no API key", async () => {
  banNetwork();
  process.env.LLM_REPLAY = "1";
  const key = llm.requestKey(REQ_SHAPE);
  fs.writeFileSync(
    path.join(tmpDir, `${key}.json`),
    JSON.stringify({
      key,
      request: REQ_SHAPE,
      response: { data: { greeting: "hi" }, usage: { promptTokens: 5, completionTokens: 2, costCents: 0.01 }, model: "test/model-1" },
    })
  );

  assert.equal(llm.isEnabled(), true, "replay mode must count as enabled so callers take the LLM path");
  const result = await llm.generateJSON(REQ);
  assert.deepEqual(result.data, { greeting: "hi" });
  assert.equal(result.replayed, true);
  assert.equal(result.usage.promptTokens, 5);
});

test("replay miss throws LLM_REPLAY_MISS instead of silently hitting the network", async () => {
  banNetwork();
  process.env.LLM_REPLAY = "1";
  await assert.rejects(
    llm.generateJSON({ ...REQ, prompt: "A prompt that was never recorded." }),
    (err) => err.code === "LLM_REPLAY_MISS" && /record/i.test(err.message)
  );
});

test("record mode persists the fixture; a later replay round-trips it", async () => {
  process.env.LLM_RECORD = "1";
  process.env.OPENROUTER_API_KEY = "test-key-not-real";
  global.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: '{"answer":42}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.0002 },
      model: "test/model-1",
    }),
  });

  const live = await llm.generateJSON(REQ);
  assert.deepEqual(live.data, { answer: 42 });

  const key = llm.requestKey(REQ_SHAPE);
  const file = path.join(tmpDir, `${key}.json`);
  assert.ok(fs.existsSync(file), "record mode must persist the fixture keyed by the request hash");
  const stored = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(stored.response.data, { answer: 42 });
  assert.deepEqual(stored.request, REQ_SHAPE);

  // Round-trip: replay now serves the same answer with the network banned.
  delete process.env.LLM_RECORD;
  process.env.LLM_REPLAY = "1";
  banNetwork();
  const replayed = await llm.generateJSON(REQ);
  assert.deepEqual(replayed.data, { answer: 42 });
  assert.equal(replayed.replayed, true);
});

test("without replay or a key, the service stays disabled and throws LLM_DISABLED", async () => {
  banNetwork();
  assert.equal(llm.isEnabled(), false);
  await assert.rejects(llm.generateJSON(REQ), (err) => err.code === "LLM_DISABLED");
});
