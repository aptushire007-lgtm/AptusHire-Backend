// RoundScorecard: the pure engine, the frozen law, and the two isolation
// guarantees that make the artifact trustworthy (blind-first payload, portal
// audience separation). All offline — the engine is pure, the model's immutability
// checker is exported pure, and the panelist payload is a pure serializer over
// already-loaded documents.
//
// What these tests are actually defending:
//   1. A rating with no evidence cannot be stored. (cite-or-abstain, for humans)
//   2. Code — never a person, never a model — computes the roll-up.
//   3. A thin round does not emit a comparable score.
//   4. A human verdict outranks a machine one, and a human never silently
//      overwrites another human.
//   5. A submitted scorecard is immutable.
//   6. The panelist payload cannot leak the engine's score.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const engine = require("../../utils/scorecardEngine");
const RoundScorecard = require("../../models/RoundScorecard");
const scorecardService = require("../../services/scorecardService");
const { VERIFICATION_STATUSES } = require("../../models/ClaimGraph");

function rubricFixture() {
  return {
    version: 4,
    criteria: [
      { id: "c1", label: "Production incident ownership", kind: "must_have", weight: 0.5, rationale: "r", probeHint: "Ask for a Sev1 they led", acceptableEvidence: ["on-call rotation"] },
      { id: "c2", label: "Team leadership", kind: "nice_to_have", weight: 0.3, rationale: "r" },
      { id: "c3", label: "Migration experience", kind: "nice_to_have", weight: 0.2, rationale: "r" },
      { id: "d1", label: "No right to work", kind: "disqualifier", weight: 0, rationale: "r" },
    ],
  };
}

// --- 1. evidence gates the rating ---------------------------------------------

test("a rating with no evidence is rejected", () => {
  const { errors } = engine.validateSubmission({
    rubric: rubricFixture(),
    ratings: [{ criterionId: "c1", rating: 4, note: "   " }],
    decision: "advance",
  });
  assert.ok(errors.length > 0);
  assert.match(errors[0], /no evidence/);
});

test("not-assessed needs no evidence — the honest path is the easy path", () => {
  const { errors, rows } = engine.validateSubmission({
    rubric: rubricFixture(),
    ratings: [{ criterionId: "c1", notAssessed: true }],
    decision: "hold",
  });
  assert.equal(errors.length, 0);
  assert.equal(rows[0].notAssessed, true);
  assert.equal(rows[0].rating, null);
});

test("a row that is neither rated nor marked not-assessed is rejected", () => {
  const { errors } = engine.validateSubmission({
    rubric: rubricFixture(),
    ratings: [{ criterionId: "c1" }],
    decision: "advance",
  });
  assert.match(errors.join(" "), /neither a rating nor/);
});

test("a criterion outside the frozen rubric cannot be scored", () => {
  const { errors } = engine.validateSubmission({
    rubric: rubricFixture(),
    ratings: [{ criterionId: "time_management", rating: 2, note: "late to standups" }],
    decision: "decline",
    decisionReason: "x",
  });
  assert.match(errors.join(" "), /Unknown or non-ratable criterion/);
});

test("disqualifiers get no rating row — they are facts, not Likert judgements", () => {
  assert.deepEqual(engine.ratableCriteria(rubricFixture()).map((c) => c.id), ["c1", "c2", "c3"]);
  const { errors } = engine.validateSubmission({
    rubric: rubricFixture(),
    ratings: [{ criterionId: "d1", rating: 1, note: "no visa" }],
    decision: "decline",
    decisionReason: "no right to work",
  });
  assert.match(errors.join(" "), /non-ratable/);
});

test("a decline must carry a stated reason (rule 6)", () => {
  const bare = engine.validateSubmission({
    rubric: rubricFixture(),
    ratings: [{ criterionId: "c1", notAssessed: true }],
    decision: "decline",
  });
  assert.match(bare.errors.join(" "), /adverse action/);

  const reasoned = engine.validateSubmission({
    rubric: rubricFixture(),
    ratings: [{ criterionId: "c1", notAssessed: true }],
    decision: "decline",
    decisionReason: "Could not evidence the must-have at any depth",
  });
  assert.equal(reasoned.errors.length, 0);
});

test("a claim verdict that moves a claim must cite something", () => {
  const { errors } = engine.validateSubmission({
    rubric: rubricFixture(),
    ratings: [{ criterionId: "c1", rating: 2, note: "vague answers", claimVerdicts: [{ claimId: "k1", verdict: "contradicted", note: "" }] }],
    decision: "hold",
  });
  assert.match(errors.join(" "), /no evidence/);
});

// --- 2/3. code computes the number, and withholds it when thin ----------------

test("the roll-up is weighted, renormalised over assessed criteria, and reproducible", () => {
  const rubric = rubricFixture();
  const { rows, errors } = engine.validateSubmission({
    rubric,
    ratings: [
      { criterionId: "c1", rating: 5, note: "Walked a Sev1 end to end" },
      { criterionId: "c2", rating: 3, note: "Mentored two juniors" },
      { criterionId: "c3", notAssessed: true },
    ],
    decision: "advance",
  });
  assert.equal(errors.length, 0);

  const rollup = engine.computeRollup({ rubric, rows });
  // c1: weight .5 × credit 1.0 ; c2: weight .3 × credit 0.5 → .65 / .8 = 81.25
  assert.equal(rollup.score, 81);
  assert.equal(Number(rollup.coverage.toFixed(2)), 0.8);
  assert.equal(rollup.assessedCount, 2);
  assert.equal(rollup.ratableCount, 3);

  const h1 = engine.reproducibilityHash({ rubricVersion: rubric.version, rows, rollup });
  const h2 = engine.reproducibilityHash({ rubricVersion: rubric.version, rows, rollup });
  assert.equal(h1, h2, "same observations must reproduce the same hash");
});

test("rating 1 earns zero credit, rating 5 earns full — the mapping is stated, not implied", () => {
  const rubric = { version: 1, criteria: [{ id: "c1", label: "L", kind: "must_have", weight: 1, rationale: "r" }] };
  const low = engine.computeRollup({ rubric, rows: [{ criterionId: "c1", rating: 1, notAssessed: false, claimVerdicts: [] }] });
  const high = engine.computeRollup({ rubric, rows: [{ criterionId: "c1", rating: 5, notAssessed: false, claimVerdicts: [] }] });
  assert.equal(low.score, 0);
  assert.equal(high.score, 100);
});

test("a thin round withholds its score instead of rendering an incomparable one", () => {
  const rubric = rubricFixture();
  const rows = [
    { criterionId: "c3", rating: 5, notAssessed: false, claimVerdicts: [] },
    { criterionId: "c1", rating: null, notAssessed: true, claimVerdicts: [] },
    { criterionId: "c2", rating: null, notAssessed: true, claimVerdicts: [] },
  ];
  const rollup = engine.computeRollup({ rubric, rows });
  assert.equal(rollup.score, null, "20% coverage must not produce a score");
  assert.match(rollup.withheldReason, /20% of this role's rubric weight/);
  // The per-criterion observations still stand — withholding the roll-up is not
  // the same as discarding what the interviewer actually saw.
  assert.equal(rollup.perCriterion.find((p) => p.criterionId === "c3").rating, 5);
});

test("nothing assessed at all yields no score and no crash", () => {
  const rollup = engine.computeRollup({
    rubric: rubricFixture(),
    rows: [{ criterionId: "c1", rating: null, notAssessed: true, claimVerdicts: [] }],
  });
  assert.equal(rollup.score, null);
  assert.equal(rollup.assessedCount, 0);
});

// --- 4. evidence hierarchy ----------------------------------------------------

test("the human verdict statuses exist on the ClaimGraph enum", () => {
  assert.ok(VERIFICATION_STATUSES.includes("verified_by_human"));
  assert.ok(VERIFICATION_STATUSES.includes("contradicted_by_human"));
});

test("a human verdict outranks every machine verdict", () => {
  for (const machine of ["unverified", "corroborated_internally", "verified_in_assessment", "verified_in_interview"]) {
    assert.ok(engine.outranks(machine, "verified_by_human"), `human should outrank ${machine}`);
  }
});

test("a machine verdict never overwrites a human one", () => {
  for (const machine of ["verified_in_assessment", "verified_in_interview", "contradicted_in_interview"]) {
    assert.equal(engine.outranks("verified_by_human", machine), false);
  }
});

test("one human never silently overwrites another — disagreement survives (rule 4)", () => {
  assert.equal(engine.outranks("verified_by_human", "contradicted_by_human"), false);
  assert.equal(engine.outranks("contradicted_by_human", "verified_by_human"), false);
});

test("inconclusive produces no write-back at all", () => {
  const writeBacks = engine.claimWriteBacks([
    { criterionId: "c1", claimVerdicts: [{ claimId: "k1", verdict: "inconclusive", note: "" }] },
  ]);
  assert.equal(writeBacks.length, 0);
});

test("verified/contradicted map onto the human statuses", () => {
  const writeBacks = engine.claimWriteBacks([
    { criterionId: "c1", claimVerdicts: [{ claimId: "k2", verdict: "contradicted", note: "said 6 services, résumé says 40" }] },
    { criterionId: "c1", claimVerdicts: [{ claimId: "k1", verdict: "verified", note: "primary on-call" }] },
  ]);
  assert.deepEqual(
    writeBacks.map((w) => [w.claimId, w.status]),
    [["k1", "verified_by_human"], ["k2", "contradicted_by_human"]]
  );
});

// --- 5. immutability ----------------------------------------------------------

test("a submitted scorecard refuses every edit", () => {
  assert.ok(RoundScorecard.submittedViolation(true, ["ratings"]));
  assert.ok(RoundScorecard.submittedViolation(true, ["decision", "decisionReason"]));
  assert.ok(RoundScorecard.submittedViolation(true, ["status"]), "not even a status change — submitted is terminal");
  assert.equal(RoundScorecard.submittedViolation(true, ["updatedAt"]), null);
});

test("an open scorecard is freely editable", () => {
  assert.equal(RoundScorecard.submittedViolation(false, ["ratings", "status", "tokenHash"]), null);
});

test("query-level updates are banned so the frozen guard can never be bypassed", async () => {
  // Document middleware is the only place the immutability guard can see a
  // change, so the query-level operators are refused outright. These reject in
  // middleware before the driver is reached — no database connection involved.
  const id = new mongoose.Types.ObjectId();
  const company = new mongoose.Types.ObjectId();
  const attempts = {
    updateOne: () => RoundScorecard.updateOne({ _id: id, company }, { $set: { decision: "advance" } }),
    updateMany: () => RoundScorecard.updateMany({ company }, { $set: { decision: "advance" } }),
    findOneAndUpdate: () => RoundScorecard.findOneAndUpdate({ _id: id, company }, { $set: { decision: "advance" } }),
    replaceOne: () => RoundScorecard.replaceOne({ _id: id, company }, { stage: "hr_interview" }),
  };
  for (const [op, run] of Object.entries(attempts)) {
    await assert.rejects(run, /does not allow query-level/, `${op} must be refused`);
  }
});

// --- 6. blind-first is structural --------------------------------------------

test("the panelist payload cannot leak the engine's score", () => {
  const rubric = rubricFixture();
  const scorecard = {
    stage: "technical_interview",
    status: "open",
    expiresAt: new Date("2026-08-04T10:00:00Z"),
    interviewer: { name: "Priya" },
    rubricVersion: rubric.version,
    targetClaims: [{ claimId: "k1", criterionId: "c1", summary: "led 40-service migration", probeHint: "ask for the service count" }],
    // Present on the document, and deliberately unreachable from the payload.
    engineSnapshot: { score: 78, band: "advance", capturedAt: new Date() },
    disagreement: { engineScore: 78, humanScore: null, delta: null, direction: "unavailable" },
  };
  const payload = scorecardService.panelistPayload({
    scorecard,
    candidate: { basicDetails: { name: "Arun K", email: "arun@example.com", phone: "999" } },
    job: { title: "Backend Engineer", department: "Engineering" },
    rubric,
  });

  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes("78"), "the engine score must not appear anywhere in the panelist payload");
  assert.equal(payload.engineSnapshot, undefined);
  assert.equal(payload.disagreement, undefined);
  // The candidate's contact details are not the panelist's business either.
  assert.ok(!serialized.includes("arun@example.com"));
  assert.ok(!serialized.includes("999"));
});

test("the panelist payload carries the probe list attached to its criterion", () => {
  const rubric = rubricFixture();
  const payload = scorecardService.panelistPayload({
    scorecard: {
      stage: "hr_interview",
      status: "open",
      expiresAt: new Date(),
      interviewer: { name: "Priya" },
      rubricVersion: 4,
      targetClaims: [{ claimId: "k1", criterionId: "c1", summary: "led 40-service migration", probeHint: "ask for the service count" }],
      engineSnapshot: { score: 78 },
    },
    candidate: { basicDetails: { name: "Arun K" } },
    job: { title: "Backend Engineer" },
    rubric,
  });

  const c1 = payload.criteria.find((c) => c.id === "c1");
  assert.equal(c1.targetClaims.length, 1);
  assert.equal(c1.targetClaims[0].summary, "led 40-service migration");
  assert.equal(payload.criteria.find((c) => c.id === "c2").targetClaims.length, 0);
  assert.equal(payload.criteria.some((c) => c.id === "d1"), false, "disqualifiers never reach the form");
});

// --- probe-list construction --------------------------------------------------

test("claims already settled by a stronger source drop off the probe list", () => {
  const rubric = rubricFixture();
  const targets = scorecardService.buildTargetClaims({
    assessment: {
      unverifiedHighWeightClaims: [
        { claimId: "k1", criterionId: "c1" },
        { claimId: "k2", criterionId: "c1" },
        { claimId: "k3", criterionId: "c2" },
      ],
    },
    graph: {
      claims: [
        { id: "k1", subject: "Led", predicate: "migration of", object: "40 services", verificationStatus: "unverified" },
        { id: "k2", subject: "Owned", predicate: "on-call for", object: "payments", verificationStatus: "verified_in_assessment" },
        { id: "k3", subject: "Managed", predicate: "", object: "4 reports", verificationStatus: "verified_by_human" },
      ],
    },
    rubric,
  });

  assert.deepEqual(targets.map((t) => t.claimId), ["k1"], "only the still-unproven claim is handed to this round");
  assert.equal(targets[0].summary, "Led migration of 40 services");
  assert.equal(targets[0].probeHint, "Ask for a Sev1 they led");
});

test("no assessment yet means an empty probe list, not a crash", () => {
  assert.deepEqual(scorecardService.buildTargetClaims({ assessment: null, graph: null, rubric: rubricFixture() }), []);
});

// --- disagreement -------------------------------------------------------------

test("disagreement is null when either side has no score — never a false zero", () => {
  assert.equal(engine.computeDisagreement({ engineScore: null, humanScore: 80 }).delta, null);
  assert.equal(engine.computeDisagreement({ engineScore: 70, humanScore: null }).delta, null);
  assert.equal(engine.computeDisagreement({ engineScore: null, humanScore: null }).direction, "unavailable");
});

test("disagreement records direction and magnitude", () => {
  assert.deepEqual(engine.computeDisagreement({ engineScore: 60, humanScore: 85 }), {
    engineScore: 60,
    humanScore: 85,
    delta: 25,
    direction: "human_higher",
  });
  assert.equal(engine.computeDisagreement({ engineScore: 90, humanScore: 50 }).direction, "human_lower");
  assert.equal(engine.computeDisagreement({ engineScore: 70, humanScore: 70 }).direction, "agree");
});
