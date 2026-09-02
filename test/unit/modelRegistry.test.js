// Model registry (BUILD-PLAN Phase 2.5) + kind-tagged metering schema (2.3).
// The rule under test: no bare model string floats in business logic — every
// call site resolves a named role, tenant overrides apply in a fixed order, and
// a typo'd role fails loudly instead of silently picking a default model.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { resolveRole, roles } = require("../../config/models");

const ENV_KEYS = ["AI_INTERVIEW_MODEL", "LLM_MODEL_EXTRACTION", "LLM_MODEL_REASONING", "LLM_MODEL_CHEAP"];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test("every role pins an explicit model id; interview carries the live prompt version", () => {
  const r = roles();
  for (const name of ["interview", "extraction", "reasoning", "cheap"]) {
    assert.ok(r[name], `role ${name} must exist`);
    assert.ok(r[name].model && typeof r[name].model === "string", `role ${name} must pin a model id`);
  }
  const { PROMPT_VERSION } = require("../../utils/interviewPrompts");
  assert.equal(r.interview.promptVersion, PROMPT_VERSION);
});

test("unknown role throws instead of silently defaulting", () => {
  assert.throws(() => resolveRole("extracton"), /Unknown LLM role/);
});

test("resolution order: per-role tenant override > legacy ai.model > env > pinned default", () => {
  // Pinned default.
  assert.equal(resolveRole("interview").model, "openai/gpt-4o-mini");

  // Env override.
  process.env.AI_INTERVIEW_MODEL = "env/model";
  assert.equal(resolveRole("interview").model, "env/model");

  // Legacy tenant field beats env — but only for the interview role.
  const legacy = { ai: { model: "tenant/legacy-model" } };
  assert.equal(resolveRole("interview", legacy).model, "tenant/legacy-model");
  process.env.LLM_MODEL_EXTRACTION = "env/extraction";
  assert.equal(resolveRole("extraction", legacy).model, "env/extraction", "ai.model must not bleed into other roles");

  // Per-role override beats everything.
  const perRole = { ai: { model: "tenant/legacy-model", models: { interview: "tenant/role-model" } } };
  assert.equal(resolveRole("interview", perRole).model, "tenant/role-model");
});

test("blank tenant overrides fall through instead of resolving to an empty model id", () => {
  assert.equal(resolveRole("interview", { ai: { model: "   " } }).model, "openai/gpt-4o-mini");
});

test("UsageEvent metering schema: distinct kinds per feature + promptVersion + cached provenance", () => {
  const UsageEvent = require("../../models/UsageEvent");
  const kinds = UsageEvent.schema.path("kind").enumValues;
  // Interview call sites (live today) and the Phase 3-8 features must be
  // separately attributable for per-feature unit economics (Phase 11 quotas).
  for (const k of ["plan", "question", "evaluation", "rubric_compile", "claim_extract", "match", "probe_gen", "report"]) {
    assert.ok(kinds.includes(k), `UsageEvent.kind must allow "${k}"`);
  }
  assert.ok(UsageEvent.schema.path("promptVersion"), "usage rows must record the prompt version (audit/reproducibility)");
  assert.ok(UsageEvent.schema.path("cached"), "cache hits must be distinguishable from live spend");
});
