// Assessment engine guardrails (ASSESSMENT-ENGINE-PLAN A1–A3). Everything here
// runs offline: the scorer/assembly/tiering are pure by design, the frozen guard
// is an exported checker, and the candidate serializer is a pure function — so
// the plan's pinned invariants (key never leaves the server, reproducibility,
// verdict rules, tier identity under counterfactuals, no unassigned sessions)
// are assertable without a DB.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const scorer = require("../../utils/assessmentScorer");
const assembly = require("../../utils/assessmentAssembly");
const AssessmentPaper = require("../../models/AssessmentPaper");
const AssessmentSession = require("../../models/AssessmentSession");
const { buildSolverPrompt } = require("../../utils/assessmentPrompts");
const { solverAgreesWithKey } = require("../../services/itemGenService");
const assessmentService = require("../../services/assessmentService");

function paperFixture() {
  return {
    version: 1,
    difficultyPolicy: { mode: "claim_tiered", fixedTier: "medium" },
    sections: [
      { id: "s1", title: "Core", criterionIds: ["c1"], servedItemCount: 2, poolItemCount: 4, timeLimitSec: 300 },
    ],
    items: [
      { id: "i1", sectionId: "s1", criterionId: "c1", type: "mcq_single", status: "active", difficulty: "hard",
        stem: "Q1", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }, { id: "d", text: "D" }],
        key: { optionIds: ["b"] } },
      { id: "i2", sectionId: "s1", criterionId: "c1", type: "numeric", status: "active", difficulty: "hard",
        stem: "Q2", options: [], key: { value: 42, tolerance: 0.5 } },
      { id: "i3", sectionId: "s1", criterionId: "c1", type: "ordering", status: "active", difficulty: "medium",
        stem: "Q3", options: [{ id: "a", text: "1" }, { id: "b", text: "2" }, { id: "c", text: "3" }, { id: "d", text: "4" }],
        key: { order: ["c", "a", "d", "b"] } },
      { id: "i4", sectionId: "s1", criterionId: "c1", type: "mcq_multi", status: "active", difficulty: "easy",
        stem: "Q4", options: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }, { id: "d", text: "D" }],
        key: { optionIds: ["a", "c"] } },
    ],
  };
}

function assembledAll(paper) {
  return paper.items.map((it, i) => ({
    itemId: it.id,
    sectionId: it.sectionId,
    order: i,
    optionOrder: (it.options || []).map((o) => o.id),
  }));
}

// --- Scorer (A2.6): pure key-match, all four types ---------------------------

test("scorer: correct answers score correct for every item type", () => {
  const paper = paperFixture();
  const result = scorer.scoreSession({
    paper,
    assembledItems: assembledAll(paper),
    responses: [
      { itemId: "i1", response: ["b"] },
      { itemId: "i2", response: 42.4 }, // inside tolerance
      { itemId: "i3", response: ["c", "a", "d", "b"] },
      { itemId: "i4", response: ["c", "a"] }, // order-independent set
    ],
  });
  assert.equal(result.totalCorrect, 4);
});

test("scorer: wrong/partial answers never score (no partial credit in v1)", () => {
  const paper = paperFixture();
  const result = scorer.scoreSession({
    paper,
    assembledItems: assembledAll(paper),
    responses: [
      { itemId: "i1", response: ["a"] },
      { itemId: "i2", response: 43.1 }, // outside tolerance
      { itemId: "i3", response: ["a", "c", "d", "b"] },
      { itemId: "i4", response: ["a"] }, // subset of the key set
    ],
  });
  assert.equal(result.totalCorrect, 0);
});

test("scorer: empty responses hit the floor, never crash", () => {
  const paper = paperFixture();
  const result = scorer.scoreSession({ paper, assembledItems: assembledAll(paper), responses: [] });
  assert.equal(result.totalCorrect, 0);
  assert.equal(result.totalItems, 4);
  assert.ok(result.perItem.every((p) => p.answered === false));
});

test("scorer: reproducibilityHash is stable across runs and response order (A2 gate)", () => {
  const paper = paperFixture();
  const responses = [
    { itemId: "i1", response: ["b"] },
    { itemId: "i2", response: 42 },
  ];
  const a = scorer.scoreSession({ paper, assembledItems: assembledAll(paper), responses });
  const b = scorer.scoreSession({ paper, assembledItems: assembledAll(paper), responses: [...responses].reverse() });
  assert.equal(a.reproducibilityHash, b.reproducibilityHash);
});

test("scorer: monotonicity — an added correct answer never lowers a criterion", () => {
  const paper = paperFixture();
  const base = scorer.scoreSession({
    paper,
    assembledItems: assembledAll(paper),
    responses: [{ itemId: "i1", response: ["b"] }],
  });
  const more = scorer.scoreSession({
    paper,
    assembledItems: assembledAll(paper),
    responses: [{ itemId: "i1", response: ["b"] }, { itemId: "i2", response: 42 }],
  });
  const c1base = base.perCriterion.find((c) => c.criterionId === "c1");
  const c1more = more.perCriterion.find((c) => c.criterionId === "c1");
  assert.ok(c1more.correctCount >= c1base.correctCount);
});

// --- Claim verdicts (A3.2): deterministic rule, contradiction never auto-acts -

test("claim verdicts: all correct → verified; majority incorrect → contradicted; else inconclusive", () => {
  const paper = paperFixture();
  const assembled = assembledAll(paper).map((a) => ({ ...a, targetsClaimId: "cl1" }));

  const allRight = scorer.scoreSession({
    paper, assembledItems: assembled,
    responses: [
      { itemId: "i1", response: ["b"] }, { itemId: "i2", response: 42 },
      { itemId: "i3", response: ["c", "a", "d", "b"] }, { itemId: "i4", response: ["a", "c"] },
    ],
  });
  assert.equal(scorer.claimVerdicts({ paper, assembledItems: assembled, perItem: allRight.perItem })[0].verdict, "verified");

  const allWrong = scorer.scoreSession({ paper, assembledItems: assembled, responses: [] });
  assert.equal(scorer.claimVerdicts({ paper, assembledItems: assembled, perItem: allWrong.perItem })[0].verdict, "contradicted");

  const half = scorer.scoreSession({
    paper, assembledItems: assembled,
    responses: [{ itemId: "i1", response: ["b"] }, { itemId: "i2", response: 42 }],
  });
  assert.equal(scorer.claimVerdicts({ paper, assembledItems: assembled, perItem: half.perItem })[0].verdict, "inconclusive");
});

// --- Tier derivation (A3.0): code over claims, override wins, counterfactual identity

test("tier: senior claims → hard, junior → easy, recruiter override beats both (A3 gate)", () => {
  const senior = assembly.deriveTierFromClaims([{ normalized: { years: 8, level: "Senior Engineer" } }]);
  assert.equal(senior.value, "hard");
  assert.ok(senior.basis.length > 0, "tier carries a human-readable basis");

  const junior = assembly.deriveTierFromClaims([{ normalized: { years: 0 } }]);
  assert.equal(junior.value, "easy");

  const paper = paperFixture();
  const overridden = assembly.resolveTier({ paper, claims: [{ normalized: { years: 9 } }], recruiterOverride: "easy" });
  assert.equal(overridden.value, "easy");
  assert.equal(overridden.source, "recruiter_override");
});

test("tier: counterfactual variants tier identically — only years/level matter (release blocker)", () => {
  const a = assembly.deriveTierFromClaims([
    { subject: "Priya Sharma", object: "React at Infosys", normalized: { years: 8, level: "senior" } },
  ]);
  const b = assembly.deriveTierFromClaims([
    { subject: "John Smith", object: "React at Google", normalized: { years: 8, level: "senior" } },
  ]);
  assert.deepEqual({ value: a.value }, { value: b.value });
});

test("tier: no claim graph degrades to the paper's fixed tier, labelled (A3 guardrail)", () => {
  const paper = paperFixture();
  const tier = assembly.resolveTier({ paper, claims: null });
  assert.equal(tier.source, "paper_fixed");
  assert.match(tier.basis, /labelled degradation|fixed/);
});

// --- Assembly (A2.2/A3.1): seeded, tier-respecting, structure-bounded --------

test("assembly: deterministic per session, varies across sessions, respects the tier", () => {
  const paper = paperFixture();
  const args = { paper, sessionId: "sess1", tier: "hard", targetClaims: [{ claimId: "cl1", criterionId: "c1" }] };
  const a = assembly.assemble(args);
  const b = assembly.assemble(args);
  assert.deepEqual(a, b);
  assert.equal(a.length, 2, "never exceeds the paper's served structure");
  const difficulties = a.map((x) => paper.items.find((i) => i.id === x.itemId).difficulty);
  assert.ok(difficulties.every((d) => d === "hard"), "hard tier exhausts the hard pool first");
  assert.ok(a.every((x) => x.targetsClaimId === "cl1"), "targeting is recorded per item");
});

test("assembly: retired and flagged items are never served", () => {
  const paper = paperFixture();
  paper.items[0].status = "retired";
  paper.items[1].status = "flagged";
  const out = assembly.assemble({ paper, sessionId: "s", tier: "hard", targetClaims: [] });
  const served = new Set(out.map((x) => x.itemId));
  assert.ok(!served.has("i1") && !served.has("i2"));
});

// --- The key never leaves the server (A2 gate) -------------------------------

test("serializer: candidate item payload contains no key anywhere", () => {
  const paper = paperFixture();
  const session = {
    assembledItems: assembledAll(paper),
    responses: [{ itemId: "i1", response: ["b"], markedForReview: false }],
  };
  const payload = assessmentService.itemsPayload(session, paper, "s1");
  assert.ok(payload.length > 0);
  const json = JSON.stringify(payload);
  assert.ok(!/"key"/.test(json), "no key field in any candidate item payload");
  assert.ok(!/"optionIds"/.test(json) && !/"tolerance"/.test(json), "no key fragments either");
});

test("solver prompt is built from stem+options only and never mentions a key", () => {
  const prompt = buildSolverPrompt({
    type: "mcq_single",
    stem: "What is X?",
    options: [{ id: "a", text: "one" }, { id: "b", text: "two" }],
  });
  assert.ok(!/key/i.test(prompt));
  assert.ok(prompt.includes("What is X?"));
});

// --- Blind-solve agreement checks are code, not a model ----------------------

test("solverAgreesWithKey: exact set/sequence/tolerance semantics", () => {
  assert.ok(solverAgreesWithKey("mcq_single", { optionIds: ["b"] }, { answerOptionIds: ["B"] }), "case-insensitive ids");
  assert.ok(!solverAgreesWithKey("mcq_single", { optionIds: ["b"] }, { answerOptionIds: ["a"] }));
  assert.ok(solverAgreesWithKey("mcq_multi", { optionIds: ["a", "c"] }, { answerOptionIds: ["c", "a"] }));
  assert.ok(!solverAgreesWithKey("mcq_multi", { optionIds: ["a", "c"] }, { answerOptionIds: ["a"] }));
  assert.ok(solverAgreesWithKey("numeric", { value: 42, tolerance: 0.5 }, { answerValue: 42.3 }));
  assert.ok(!solverAgreesWithKey("numeric", { value: 42, tolerance: 0.5 }, { answerValue: 43 }));
  assert.ok(solverAgreesWithKey("ordering", { order: ["c", "a"] }, { answerOptionIds: ["c", "a"] }));
  assert.ok(!solverAgreesWithKey("ordering", { order: ["c", "a"] }, { answerOptionIds: ["a", "c"] }));
});

// --- Frozen paper immutability (A1 gate, same law as RoleRubric) -------------

test("frozen paper: content mutations rejected; archive, retire, exposure allowed", () => {
  const fv = AssessmentPaper.frozenViolation;
  assert.equal(fv(false, ["items.0.stem"], "draft", []), null, "drafts are freely editable");
  assert.match(fv(true, ["items.0.stem"], "approved", []) || "", /frozen/);
  assert.match(fv(true, ["sections"], "approved", []) || "", /frozen/);
  assert.equal(fv(true, ["status"], "archived", []), null);
  assert.match(fv(true, ["status"], "draft", []) || "", /archived/);
  assert.equal(fv(true, ["items", "items.0.status"], "approved", [{ from: "active", to: "retired" }]), null);
  assert.match(fv(true, ["items", "items.0.status"], "approved", [{ from: "flagged", to: "active" }]) || "", /retired/);
  assert.equal(fv(true, ["items", "items.0.exposure.serves"], "approved", []), null, "telemetry counters are permitted");
});

// --- No session without an assignment (A2 guardrail) -------------------------

test("AssessmentSession schema requires the recruiter assignment", () => {
  const base = {
    candidate: new mongoose.Types.ObjectId(),
    job: new mongoose.Types.ObjectId(),
    company: new mongoose.Types.ObjectId(),
    paper: new mongoose.Types.ObjectId(),
    paperVersion: 1,
    tokenHash: "x".repeat(64),
    validFrom: new Date(),
    startDeadline: new Date(),
    expiresAt: new Date(),
  };
  const unassigned = new AssessmentSession(base);
  assert.ok(unassigned.validateSync(), "a session with no assignment must not validate");

  const assigned = new AssessmentSession({
    ...base,
    assignment: { assignedByName: "Recruiter", at: new Date(), mode: "manual" },
  });
  assert.equal(assigned.validateSync(), undefined);
});

// --- Item criterion linkage is schema-required (rule 3) ----------------------

test("an item without a criterionId cannot exist on a paper", () => {
  const paper = new AssessmentPaper({
    job: new mongoose.Types.ObjectId(),
    company: new mongoose.Types.ObjectId(),
    rubric: new mongoose.Types.ObjectId(),
    rubricVersion: 1,
    version: 1,
    compiledBy: { engine: "ai", at: new Date() },
    sections: [{ id: "s1", title: "Core", criterionIds: ["c1"], servedItemCount: 2, poolItemCount: 4, timeLimitSec: 300 }],
    items: [{ id: "i1", sectionId: "s1", type: "mcq_single", stem: "Q", options: [], key: { optionIds: ["a"] }, difficulty: "easy" }],
  });
  const err = paper.validateSync();
  assert.ok(err && /criterionId/.test(String(err)), "criterionId is schema-required on every item");
});

// --- Run liveness: an orphaned generation run must not wedge the paper --------
// A run exists only in the memory of the process that started it. When that
// process dies mid-run nothing writes the terminal status, so the paper stays at
// `status: "running"` forever — and BOTH recovery paths (Resume, Approve) gate on
// that flag, leaving the paper unrecoverable from the UI. Liveness is therefore
// proven by heartbeat, not claimed by status.

const { isRunStale, isRunActive } = require("../../services/itemGenService");

const MIN = 60 * 1000;

test("a run beating recently is active and not stale", () => {
  const run = { status: "running", startedAt: new Date(0), heartbeatAt: new Date(100 * MIN) };
  const now = 101 * MIN;
  assert.equal(isRunStale(run, now), false);
  assert.equal(isRunActive(run, now), true);
});

test("a run whose heartbeat went quiet past the window is stale and takeable", () => {
  const run = { status: "running", startedAt: new Date(0), heartbeatAt: new Date(100 * MIN) };
  const now = 100 * MIN + 16 * MIN; // default window is 15 min
  assert.equal(isRunStale(run, now), true);
  assert.equal(isRunActive(run, now), false, "a dead run must never block Resume or Approve");
});

test("a legacy run with no heartbeat falls back to startedAt", () => {
  const fresh = { status: "running", startedAt: new Date(100 * MIN) };
  assert.equal(isRunStale(fresh, 101 * MIN), false, "recently started, just hasn't finished item 1 yet");
  assert.equal(isRunStale(fresh, 120 * MIN), true, "started 20 min ago and never beat — the process is gone");
});

test("a run with neither heartbeat nor startedAt is stale, never permanently blocking", () => {
  assert.equal(isRunStale({ status: "running" }, 0), true);
});

test("only a running run can be stale — terminal states are never 'stale'", () => {
  for (const status of ["idle", "completed", "failed"]) {
    const run = { status, startedAt: new Date(0), heartbeatAt: new Date(0) };
    assert.equal(isRunStale(run, 999 * MIN), false, `${status} is a terminal state, not a stalled run`);
    assert.equal(isRunActive(run, 999 * MIN), false, `${status} must not read as an active run`);
  }
});

test("a missing generationRun blocks nothing", () => {
  assert.equal(isRunStale(undefined, 0), false);
  assert.equal(isRunActive(undefined, 0), false);
});

// --- Pool sizing & cost visibility -------------------------------------------
// The recruiter sets ONE number ("questions served"); generation runs off
// poolItemCount, and in claim_tiered mode off poolItemCount × 3 tiers. That gap
// is deliberate — a bank bigger than the served count is what makes each
// candidate's draw different and what lets flagged items be discarded — but it
// must be (a) tied to the served count so an edit can't strand it, and (b) shown
// before it is spent.

const paperService = require("../../services/assessmentPaperService");
const { generationPlan, buildSpecs } = require("../../services/itemGenService");

function planSection(over = {}) {
  return {
    id: "s1",
    title: "Core",
    criterionIds: ["c1"],
    servedItemCount: 4,
    poolItemCount: 8,
    difficultyMix: { easy: 1, medium: 2, hard: 1 },
    timeLimitSec: 300,
    ...over,
  };
}

test("the item bank is clamped to [served, 2× served] in both directions", () => {
  assert.equal(paperService.normalisePool(16, 3), 6, "lowering the served count must shrink the bank with it");
  assert.equal(
    paperService.normalisePool(4, 8),
    8,
    "a bank below the served count leaves the section permanently unapprovable — poolItemCount has no UI control"
  );
  assert.equal(paperService.normalisePool(10, 6), 10, "a bank already in range is left alone");
});

test("claim_tiered costs 3× fixed, and the plan says so out loud", () => {
  const sections = [planSection()];
  const fixed = generationPlan({ difficultyPolicy: { mode: "fixed" }, sections });
  const tiered = generationPlan({ difficultyPolicy: { mode: "claim_tiered" }, sections });

  assert.equal(fixed.sections[0].planned, 8, "fixed generates the bank (2× served), not the served count");
  assert.equal(fixed.sections[0].servedItemCount, 4, "and the served count rides along so the editor can show both");
  assert.equal(tiered.sections[0].planned, tiered.sections[0].perTier * 3, "one bank per difficulty tier");
  assert.ok(tiered.total > fixed.total, "the tier multiplier must be visible, never silent");
});

test("the plan the editor shows is exactly what buildSpecs will generate", () => {
  const rubric = { criteria: [{ id: "c1", probeHint: "" }] };
  for (const mode of ["fixed", "claim_tiered"]) {
    const paper = { difficultyPolicy: { mode }, sections: [planSection(), planSection({ id: "s2" })] };
    assert.equal(
      buildSpecs(paper, rubric).length,
      generationPlan(paper).total,
      `${mode}: the quoted cost must equal the generated cost, or the editor is lying about spend`
    );
  }
});

test("a plan over the per-paper ceiling is flagged as capped, not quietly truncated", () => {
  const sections = Array.from({ length: 5 }, (_, i) => planSection({ id: `s${i + 1}` }));
  const plan = generationPlan({ difficultyPolicy: { mode: "claim_tiered" }, sections });
  assert.ok(plan.uncappedTotal > plan.paperCap, "fixture must exceed the ceiling for this test to mean anything");
  assert.equal(plan.capped, true);
  assert.equal(plan.total, plan.paperCap, "the honest number is what will actually be built");
});

test("heartbeatAt is a real schema path, so the loop's stamp persists", () => {
  const paper = new AssessmentPaper({
    job: new mongoose.Types.ObjectId(),
    company: new mongoose.Types.ObjectId(),
    rubric: new mongoose.Types.ObjectId(),
    rubricVersion: 1,
    version: 1,
    compiledBy: { engine: "ai", at: new Date() },
    generationRun: { status: "running", startedAt: new Date(), heartbeatAt: new Date(100 * MIN) },
  });
  assert.equal(paper.validateSync(), undefined);
  assert.equal(paper.generationRun.heartbeatAt.getTime(), 100 * MIN);
});
