// Rubric engine (BUILD-PLAN Phase 3). Pins the code-side arithmetic and the JD
// quality detectors, including the acceptance-gate fixture: a deliberately bad
// JD must fire flags; a clean JD must not.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const engine = require("../../utils/rubricEngine");

// Deterministic PRNG (mulberry32) so the property test is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Weight normalisation (acceptance gate: property test) -------------------

test("PROPERTY: weights always sum to exactly 1.0 after normalisation (200 random rubrics)", () => {
  const rand = rng(20260725);
  const kinds = ["must_have", "nice_to_have", "disqualifier"];
  for (let iter = 0; iter < 200; iter++) {
    const n = 1 + Math.floor(rand() * engine.MAX_CRITERIA);
    const criteria = Array.from({ length: n }, (_, i) => ({
      id: `c${i + 1}`,
      kind: kinds[Math.floor(rand() * 3)],
      // Adversarial proposals: negatives, zeros, huge values, NaN-ish.
      weight: [-5, 0, rand() * 100, 1e9, NaN, undefined][Math.floor(rand() * 6)],
    }));
    engine.normaliseWeights(criteria);

    const scoreable = criteria.filter((c) => c.kind !== "disqualifier");
    for (const c of criteria) {
      if (c.kind === "disqualifier") assert.equal(c.weight, 0, "disqualifiers are gates, never weighted");
      else assert.ok(c.weight >= 0 && c.weight <= 1, `weight out of range: ${c.weight}`);
    }
    if (scoreable.length) {
      const sum = scoreable.reduce((s, c) => s + c.weight, 0);
      assert.ok(Math.abs(sum - 1) < 1e-12, `iteration ${iter}: weights sum to ${sum}, not 1.0`);
    }
  }
});

test("all-zero proposed weights split equally instead of dividing by zero", () => {
  const criteria = [
    { id: "c1", kind: "must_have", weight: 0 },
    { id: "c2", kind: "must_have", weight: 0 },
    { id: "c3", kind: "nice_to_have", weight: 0 },
  ];
  engine.normaliseWeights(criteria);
  for (const c of criteria) assert.ok(Math.abs(c.weight - 1 / 3) < 1e-12);
});

test("an all-disqualifier rubric carries zero weight everywhere", () => {
  const criteria = [
    { id: "c1", kind: "disqualifier", weight: 5 },
    { id: "c2", kind: "disqualifier", weight: 3 },
  ];
  engine.normaliseWeights(criteria);
  for (const c of criteria) assert.equal(c.weight, 0);
});

// ---- Importance tiers (the recruiter picks a word, code picks the number) ----

test("applyImportance derives kind and relative weight from the tier word — nothing else sets them", () => {
  for (const tier of engine.IMPORTANCE_TIERS) {
    const c = engine.applyImportance({ importance: tier.key, kind: "nonsense", weight: 999 });
    assert.equal(c.kind, tier.kind);
    assert.equal(c.weight, tier.multiplier);
  }
});

test("the ladder is geometric: Critical is worth exactly 2 Important, 4 Helpful, 8 Bonus", () => {
  const m = Object.fromEntries(engine.IMPORTANCE_TIERS.map((t) => [t.key, t.multiplier]));
  assert.equal(m.critical, m.important * 2);
  assert.equal(m.important, m.helpful * 2);
  assert.equal(m.helpful, m.bonus * 2);
});

test("a Critical criterion ends up weighing exactly twice an Important one after normalisation", () => {
  const criteria = [
    engine.applyImportance({ id: "c1", importance: "critical" }),
    engine.applyImportance({ id: "c2", importance: "important" }),
    engine.applyImportance({ id: "c3", importance: "bonus" }),
  ];
  engine.normaliseWeights(criteria);
  assert.ok(Math.abs(criteria[0].weight - 2 * criteria[1].weight) < 1e-12);
  assert.ok(Math.abs(criteria[0].weight - 8 / 13) < 1e-12);
  assert.ok(Math.abs(criteria.reduce((s, c) => s + c.weight, 0) - 1) < 1e-12);
});

test("importanceOf falls back to the authored kind for pre-tier criteria, and refuses to rank a gate", () => {
  assert.equal(engine.importanceOf({ importance: "helpful", kind: "must_have" }), "helpful", "an explicit tier always wins");
  assert.equal(engine.importanceOf({ kind: "must_have" }), "critical");
  assert.equal(engine.importanceOf({ kind: "nice_to_have" }), "helpful");
  assert.equal(engine.importanceOf({ kind: "disqualifier" }), null);
  assert.equal(engine.importanceOf({ importance: "made_up" }), null);
});

test("thresholdPresetKey names a preset pair and admits when a pair is custom", () => {
  assert.equal(engine.thresholdPresetKey({ advance: 60, review: 45 }), "balanced");
  assert.equal(engine.thresholdPresetKey({ advance: 80, review: 65 }), "very_selective");
  assert.equal(engine.thresholdPresetKey({ advance: 63, review: 41 }), "custom");
  for (const p of engine.THRESHOLD_PRESETS) {
    assert.ok(p.review < p.advance, `preset ${p.key} must leave a review band — ambiguity has to reach a human`);
  }
});

// ---- JD quality detectors (acceptance gate: bad-JD fixture) ------------------

const BAD_JD = [
  "We need a rockstar engineer. 12+ years of React experience required, plus 5 years of Bun in production.",
  "Ivy League preferred; we hire digital natives who are native English speakers.",
  "Continuous employment history with no gaps. Must be from IIT or IIM only.",
].join("\n");

test("ACCEPTANCE GATE: every detector fires on the deliberately bad JD, with verbatim evidence", () => {
  const flags = engine.detectQualityFlags(BAD_JD, { nowYear: 2026 });
  const byCode = Object.fromEntries(flags.map((f) => [f.code, f]));

  for (const code of ["YEARS_EXCEED_TECH_AGE", "ELITE_PROXY", "NATIVE_SPEAKER", "DIGITAL_NATIVE", "CONTINUOUS_EMPLOYMENT", "UNQUANTIFIABLE_HYPE"]) {
    assert.ok(byCode[code], `expected flag ${code} to fire`);
    assert.ok(BAD_JD.includes(byCode[code].evidence), `${code} evidence must be a verbatim JD substring`);
  }
  assert.equal(byCode.YEARS_EXCEED_TECH_AGE.severity, "critical");
  // Both impossible asks are present (12y React at age 13 is fine; 5y Bun at age 4 is not;
  // 12y React would also pass — the React hit here comes from nothing: verify explicitly below).
  const techFlags = flags.filter((f) => f.code === "YEARS_EXCEED_TECH_AGE");
  assert.ok(techFlags.some((f) => /bun/i.test(f.message)), "5 years of Bun (born 2022) is impossible in 2026");
});

test("the tech-age detector is honest: a FEASIBLE years-ask does not fire", () => {
  // React was born 2013 → 13 years old in 2026. Asking for 10 is aggressive but possible.
  const flags = engine.detectQualityFlags("10+ years of React experience.", { nowYear: 2026 });
  assert.equal(flags.filter((f) => f.code === "YEARS_EXCEED_TECH_AGE").length, 0);
  // 15 years of React in 2026 is impossible and must fire.
  const impossible = engine.detectQualityFlags("15+ years of React experience.", { nowYear: 2026 });
  assert.equal(impossible.filter((f) => f.code === "YEARS_EXCEED_TECH_AGE").length, 1);
});

test("a clean JD produces zero flags (no false positives)", () => {
  const clean =
    "Backend engineer for our payments team. 4+ years of professional experience with Node.js and MongoDB. " +
    "You will design REST APIs, own reliability, and mentor junior engineers. Professional working proficiency in English.";
  assert.deepEqual(engine.detectQualityFlags(clean, { nowYear: 2026 }), []);
});

test("must-have overload flags above 10, stays quiet at 10", () => {
  const make = (n) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, kind: "must_have", weight: 1 }));
  assert.equal(engine.detectQualityFlags("", { criteria: make(10) }).length, 0);
  const flags = engine.detectQualityFlags("", { criteria: make(11) });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].code, "MUST_HAVE_OVERLOAD");
});

// ---- Cite-or-drop for model-proposed flags (engineering rule 2) --------------

test("model flags survive ONLY with an allow-listed code and a verbatim citation", () => {
  const source = "Must have excellent communication skills and strong leadership.";
  const { accepted, dropped } = engine.verifyModelFlags(
    [
      { code: "UNQUANTIFIABLE_REQUIREMENT", message: "Not testable as written.", evidence: "excellent communication skills" }, // ok
      { code: "UNQUANTIFIABLE_REQUIREMENT", message: "Hallucinated quote.", evidence: "world-class hustle mindset" }, // not in source
      { code: "MADE_UP_CODE", message: "Whatever.", evidence: "strong leadership" }, // code not allowed
      { code: "AMBIGUOUS_REQUIREMENT", message: "", evidence: "strong leadership" }, // empty message
      { code: "AMBIGUOUS_REQUIREMENT", message: "No quote given." }, // missing evidence
    ],
    source
  );
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].code, "UNQUANTIFIABLE_REQUIREMENT");
  assert.equal(dropped.length, 4);
});

// ---- AI-output sanitisation --------------------------------------------------

test("sanitiseAiCriteria drops invalid entries, never repairs them into things the model didn't say", () => {
  const out = engine.sanitiseAiCriteria([
    { label: "Node.js APIs", importance: "critical", rationale: "JD requires it.", evidenceTypes: ["skill", "bogus"], acceptableEvidence: ["built APIs", ""], probeHint: "Ask about routing.", seniorityFloor: "mid" },
    { label: "", importance: "critical", rationale: "No label." }, // dropped
    { label: "No rationale", importance: "critical", rationale: "" }, // dropped
    { label: "Unrankable", importance: "extremely_critical", rationale: "x" }, // dropped: no tier, no legacy kind
    { label: "Degree", importance: "bonus", rationale: "Listed as preferred." },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.id), ["c1", "c2"]);
  assert.deepEqual(out[0].evidenceTypes, ["skill"], "unknown evidence types are filtered");
  assert.deepEqual(out[0].acceptableEvidence, ["built APIs"]);
  assert.equal(out[0].kind, "must_have", "kind is derived from the tier, not taken from the model");
  const sum = out.reduce((s, c) => s + c.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);
});

test("sanitiseAiCriteria ignores any number the model volunteers — only the tier word sets the weight", () => {
  const out = engine.sanitiseAiCriteria([
    { label: "A", importance: "bonus", relativeImportance: 100, weight: 0.99, rationale: "r" },
    { label: "B", importance: "critical", relativeImportance: 1, weight: 0.01, rationale: "r" },
  ]);
  assert.ok(out[1].weight > out[0].weight, "the word wins over the number, every time");
  assert.ok(Math.abs(out[1].weight - 8 / 9) < 1e-12);
});

test("a pre-tier proposal still lands on the ladder, but a proposed knock-out gate is dropped", () => {
  const out = engine.sanitiseAiCriteria([
    { label: "Legacy must", kind: "must_have", relativeImportance: 90, rationale: "r" },
    { label: "Legacy must, softer", kind: "must_have", relativeImportance: 30, rationale: "r" },
    { label: "Legacy nice", kind: "nice_to_have", relativeImportance: 60, rationale: "r" },
    { label: "Legacy nice, minor", kind: "nice_to_have", relativeImportance: 5, rationale: "r" },
    { label: "No right to work", kind: "disqualifier", relativeImportance: 0, rationale: "r" }, // dropped
  ]);
  assert.deepEqual(
    out.map((c) => c.importance),
    ["critical", "important", "helpful", "bonus"]
  );
  assert.equal(out.some((c) => c.kind === "disqualifier"), false, "knock-out gates are no longer authored");
});

// ---- Deterministic fallback (acceptance gate: usable + labelled) -------------

test("ACCEPTANCE GATE: with no LLM, the fallback drafts a usable, labelled rubric from structured fields", () => {
  const job = {
    title: "Backend Engineer",
    description: "Build APIs.",
    requiredSkills: ["node.js", "mongodb"],
    minExperienceYears: 3,
    requiredEducation: "Bachelor's degree in Computer Science",
    atsThreshold: 65,
  };
  const { criteria, qualityFlags } = engine.deterministicDraft(job);

  assert.equal(criteria.length, 4); // 2 skills + experience + education
  for (const c of criteria) {
    assert.ok(c.label && c.rationale, "every criterion carries a label and a non-empty rationale");
    assert.ok(engine.AUTHORABLE_KINDS.includes(c.kind), "the fallback never drafts a knock-out gate");
    assert.ok(engine.IMPORTANCE_KEYS.includes(c.importance), "every drafted criterion carries a tier word");
  }
  const sum = criteria.reduce((s, c) => s + c.weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-12);

  const codes = qualityFlags.map((f) => f.code);
  assert.ok(codes.includes("FALLBACK_COMPILE"), "degraded path must label itself (rule 5)");
  assert.ok(codes.includes("EDUCATION_REQUIREMENT"), "degree requirements get the disparate-impact advisory");
});

test("a job with no structured fields yields zero criteria and a critical flag — never invented criteria", () => {
  const { criteria, qualityFlags } = engine.deterministicDraft({ title: "X", description: "Y" });
  assert.equal(criteria.length, 0);
  assert.ok(qualityFlags.some((f) => f.code === "NO_STRUCTURED_FIELDS" && f.severity === "critical"));
});

// ---- Source hash + thresholds ------------------------------------------------

test("sourceHash is stable across line-ending styles and sensitive to content", () => {
  const job = { title: "T", description: "line1\nline2", requiredSkills: ["a"] };
  const crlf = { title: "T", description: "line1\r\nline2", requiredSkills: ["a"] };
  assert.equal(engine.sourceHashOf(job), engine.sourceHashOf(crlf));
  assert.notEqual(engine.sourceHashOf(job), engine.sourceHashOf({ ...job, description: "line1\nline3" }));
});

test("defaultThresholds derive from the job's ATS threshold with a 15-point review band", () => {
  assert.deepEqual(engine.defaultThresholds({ atsThreshold: 70 }), { advance: 70, review: 55 });
  assert.deepEqual(engine.defaultThresholds({}), { advance: 60, review: 45 });
  assert.deepEqual(engine.defaultThresholds({ atsThreshold: 10 }), { advance: 10, review: 0 });
});
