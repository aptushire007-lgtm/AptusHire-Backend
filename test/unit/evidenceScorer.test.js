// Phase 6 acceptance gates — the deterministic scorer IS the legal surface,
// so its arithmetic is pinned by property tests over seeded-random inputs:
//   score ∈ [0,100] · decomposition sums exactly · reordering-invariance ·
//   upward-status monotonicity · disqualifier ⇒ fail · empty claims never pass ·
//   100 consecutive runs byte-identical · reproducibilityHash stability.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  computeAssessment,
  reproducibilityHash,
  VERIFICATION_MULT,
  SPECIFICITY_MULT,
} = require("../../utils/evidenceScorer");
const { sanitiseFindings } = require("../../services/evidenceMatcher");

// Deterministic PRNG (same generator the rubric property tests use).
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SPECS = ["vague", "specific", "quantified"];
const VERS = ["unverified", "corroborated_internally", "contradicted_internally", "verified_in_interview", "contradicted_in_interview"];
const STATUSES = ["satisfied", "partial", "absent", "contradicted"];

function randomFixture(rnd, { withDisqualifier = false } = {}) {
  const n = 2 + Math.floor(rnd() * 6);
  const weights = Array.from({ length: n }, () => rnd());
  const wsum = weights.reduce((s, w) => s + w, 0) || 1;
  const criteria = weights.map((w, i) => ({
    id: `c${i + 1}`,
    label: `Criterion ${i + 1}`,
    kind: "must_have",
    weight: w / wsum,
  }));
  if (withDisqualifier) {
    criteria.push({ id: "dq1", label: "Needs on-site presence in Pune", kind: "disqualifier", weight: 0 });
  }

  const claims = Array.from({ length: 1 + Math.floor(rnd() * 10) }, (_, i) => ({
    id: `k${i + 1}`,
    type: "skill",
    subject: "candidate",
    predicate: "uses",
    object: `tool${i}`,
    specificity: SPECS[Math.floor(rnd() * SPECS.length)],
    verificationStatus: VERS[Math.floor(rnd() * VERS.length)],
    selfReportedOnly: true,
    spans: [{ start: 0, end: 5, quote: "quote" }],
  }));

  const findings = criteria.map((c) => ({
    criterionId: c.id,
    status: STATUSES[Math.floor(rnd() * STATUSES.length)],
    supportingClaimIds: claims.filter(() => rnd() < 0.4).map((k) => k.id),
    reasoning: "r",
    confidence: rnd(),
  }));

  const advance = 30 + Math.floor(rnd() * 50);
  const review = Math.max(0, advance - 10 - Math.floor(rnd() * 20));
  return { rubric: { criteria, thresholds: { advance, review } }, claims, findings };
}

test("PROPERTY: 300 random assessments — score in [0,100], decomposition exact, decision consistent", () => {
  const rnd = mulberry32(20260725);
  for (let i = 0; i < 300; i += 1) {
    const fx = randomFixture(rnd, { withDisqualifier: rnd() < 0.3 });
    const a = computeAssessment(fx);

    assert.ok(a.overallScore >= 0 && a.overallScore <= 100, `iteration ${i}: score ${a.overallScore}`);

    const sum = a.criterionFindings.reduce((s, f) => s + f.points, 0);
    assert.ok(Math.abs(sum - a.overallRaw) < 1e-6, `iteration ${i}: decomposition broke (${sum} vs ${a.overallRaw})`);

    const bandDecision = { advance: "pass", review: "review", decline: "fail" };
    assert.equal(bandDecision[a.band], a.decision, `iteration ${i}: band/decision mismatch`);
  }
});

test("PROPERTY: reordering criteria and findings never changes the total", () => {
  const rnd = mulberry32(777);
  for (let i = 0; i < 100; i += 1) {
    const fx = randomFixture(rnd);
    const a = computeAssessment(fx);
    const reversed = computeAssessment({
      rubric: { ...fx.rubric, criteria: [...fx.rubric.criteria].reverse() },
      claims: [...fx.claims].reverse(),
      findings: [...fx.findings].reverse(),
    });
    assert.equal(a.overallScore, reversed.overallScore, `iteration ${i}`);
    assert.equal(a.decision, reversed.decision, `iteration ${i}`);
  }
});

test("PROPERTY: moving any criterion's status upward never lowers the score", () => {
  const rnd = mulberry32(4242);
  const upward = { absent: "partial", contradicted: "partial", partial: "satisfied" };
  for (let i = 0; i < 100; i += 1) {
    const fx = randomFixture(rnd);
    // Ensure upgraded findings keep at least one supporting claim so the
    // upgrade isn't voided by cite-or-abstain.
    for (const f of fx.findings) if (f.supportingClaimIds.length === 0) f.supportingClaimIds = [fx.claims[0].id];
    const base = computeAssessment(fx);
    for (let j = 0; j < fx.findings.length; j += 1) {
      const next = upward[fx.findings[j].status];
      if (!next) continue;
      const upgraded = fx.findings.map((f, idx) => (idx === j ? { ...f, status: next } : f));
      const b = computeAssessment({ ...fx, findings: upgraded });
      assert.ok(
        b.overallScore >= base.overallScore,
        `iteration ${i}, finding ${j}: upgrade ${fx.findings[j].status}→${next} lowered ${base.overallScore}→${b.overallScore}`
      );
    }
  }
});

test("PROPERTY: a satisfied disqualifier always yields fail, regardless of the numbers", () => {
  const rnd = mulberry32(99);
  for (let i = 0; i < 100; i += 1) {
    const fx = randomFixture(rnd, { withDisqualifier: true });
    // Force every scoreable criterion to full marks…
    for (const f of fx.findings) {
      f.status = "satisfied";
      f.supportingClaimIds = [fx.claims[0].id];
    }
    fx.claims[0].specificity = "quantified";
    fx.claims[0].verificationStatus = "verified_in_interview";
    // …and trip the gate.
    const dq = fx.findings.find((f) => f.criterionId === "dq1");
    dq.status = "satisfied";
    const a = computeAssessment(fx);
    assert.equal(a.decision, "fail", `iteration ${i}`);
    assert.match(a.reviewReason, /^disqualifier:/);
  }
});

test("GUARDRAIL: an ambiguous (partial) disqualifier routes to review, never to fail or pass", () => {
  const rnd = mulberry32(55);
  const fx = randomFixture(rnd, { withDisqualifier: true });
  for (const f of fx.findings) {
    f.status = "satisfied";
    f.supportingClaimIds = [fx.claims[0].id];
  }
  const dq = fx.findings.find((f) => f.criterionId === "dq1");
  dq.status = "partial";
  const a = computeAssessment(fx);
  assert.equal(a.decision, "review");
  assert.match(a.reviewReason, /^disqualifier_ambiguous:/);
});

test("GUARDRAIL: an empty claim set never yields a pass — even with a degenerate 0 threshold", () => {
  const rubric = {
    criteria: [{ id: "c1", label: "X", kind: "must_have", weight: 1 }],
    thresholds: { advance: 0, review: 0 },
  };
  const a = computeAssessment({ rubric, claims: [], findings: [{ criterionId: "c1", status: "satisfied", supportingClaimIds: [], reasoning: "", confidence: 1 }] });
  assert.notEqual(a.decision, "pass");
  assert.equal(a.reviewReason, "no_evidence");
});

test("ACCEPTANCE GATE: 100 consecutive runs are byte-identical (pure function, zero variance)", () => {
  const rnd = mulberry32(31337);
  const fx = randomFixture(rnd);
  const first = JSON.stringify(computeAssessment(fx));
  for (let i = 0; i < 99; i += 1) {
    assert.equal(JSON.stringify(computeAssessment(fx)), first, `run ${i + 2} diverged`);
  }
});

test("the verification multiplier is the thesis: verified > corroborated > self-reported > contradicted", () => {
  assert.ok(VERIFICATION_MULT.verified_in_interview > VERIFICATION_MULT.corroborated_internally);
  assert.ok(VERIFICATION_MULT.corroborated_internally > VERIFICATION_MULT.unverified);
  assert.ok(VERIFICATION_MULT.unverified > VERIFICATION_MULT.contradicted_internally);
  assert.equal(VERIFICATION_MULT.contradicted_in_interview, 0);
  assert.ok(SPECIFICITY_MULT.quantified > SPECIFICITY_MULT.specific);
  assert.ok(SPECIFICITY_MULT.specific > SPECIFICITY_MULT.vague);

  // And it moves real scores in the right direction.
  const rubric = { criteria: [{ id: "c1", label: "X", kind: "must_have", weight: 1 }], thresholds: { advance: 60, review: 45 } };
  const claim = (ver) => [{ id: "k1", specificity: "specific", verificationStatus: ver, selfReportedOnly: true, spans: [{ start: 0, end: 1, quote: "q" }] }];
  const finding = [{ criterionId: "c1", status: "satisfied", supportingClaimIds: ["k1"], reasoning: "", confidence: 1 }];
  const scores = ["unverified", "corroborated_internally", "verified_in_interview"].map(
    (v) => computeAssessment({ rubric, claims: claim(v), findings: finding }).overallScore
  );
  assert.ok(scores[0] < scores[1] && scores[1] < scores[2], `expected strictly rising scores, got ${scores}`);
});

test("reproducibilityHash: stable for same inputs, different for any changed component", () => {
  const base = { rubricId: "r1", rubricVersion: 2, resumeHash: "abc", promptVersions: ["p1", "p2"], modelId: "m" };
  const h1 = reproducibilityHash(base);
  assert.equal(reproducibilityHash({ ...base }), h1);
  for (const change of [{ rubricVersion: 3 }, { resumeHash: "abd" }, { modelId: "m2" }, { promptVersions: ["p1", "p3"] }]) {
    assert.notEqual(reproducibilityHash({ ...base, ...change }), h1, JSON.stringify(change));
  }
});

// ---------------------------------------------------------------------------
// Matcher sanitisation (cite-or-abstain for judgements)
// ---------------------------------------------------------------------------

test("sanitiseFindings: unknown criteria dropped, unknown claims filtered, unevidenced verdicts degrade to absent", () => {
  const rubric = { criteria: [{ id: "c1", label: "A", kind: "must_have", weight: 1 }, { id: "c2", label: "B", kind: "must_have", weight: 0 }] };
  const claims = [{ id: "k1" }];
  const out = sanitiseFindings(
    [
      { criterionId: "c1", status: "satisfied", supportingClaimIds: ["k1", "kFAKE"], reasoning: "ok", confidence: 0.9 },
      { criterionId: "cGHOST", status: "satisfied", supportingClaimIds: ["k1"], reasoning: "x", confidence: 1 },
      { criterionId: "c2", status: "contradicted", supportingClaimIds: ["kFAKE"], reasoning: "x", confidence: 1 },
    ],
    rubric,
    claims
  );
  assert.equal(out.length, 2, "one finding per rubric criterion, ghosts dropped");
  const c1 = out.find((f) => f.criterionId === "c1");
  assert.deepEqual(c1.supportingClaimIds, ["k1"], "fabricated claim id filtered");
  const c2 = out.find((f) => f.criterionId === "c2");
  assert.equal(c2.status, "absent", "a verdict with no surviving evidence must abstain");
});
