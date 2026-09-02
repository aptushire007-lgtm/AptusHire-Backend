// Phase 10 acceptance gates — calibration:
//   - the curve computes correct per-bin rates with sane Wilson intervals;
//   - display is hidden below the honest minimums (total AND per-bin);
//   - outcome capture maps stages to milestones and never un-decides one;
//   - criterion insights classify predictive / no-signal / inverse correctly;
//   - GUARDRAIL (provable in code): the scorer has no calibration dependency
//     and the calibration service never writes a rubric — weights cannot be
//     auto-tuned from outcomes.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  computeBins,
  wilson,
  calibrationForScore,
  classifyCriterion,
  INSIGHT_MIN_N,
} = require("../../services/calibrationService");
const { outcomeForStage, nextOutcome } = require("../../services/scoreOutcomeService");

function rows(spec) {
  // spec: [{score, outcome, count}]
  const out = [];
  for (const s of spec) for (let i = 0; i < (s.count || 1); i += 1) out.push({ score: s.score, outcome: s.outcome });
  return out;
}

// ---------------------------------------------------------------------------
// Binning + Wilson
// ---------------------------------------------------------------------------

test("computeBins: per-bin advancement rates are exact and empty bins are omitted", () => {
  const bins = computeBins(
    rows([
      { score: 72, outcome: "advanced", count: 6 },
      { score: 75, outcome: "rejected", count: 4 },
      { score: 35, outcome: "rejected", count: 5 },
    ])
  );
  assert.equal(bins.length, 2);
  const b70 = bins.find((b) => b.lo === 70);
  assert.equal(b70.n, 10);
  assert.equal(b70.advanced, 6);
  assert.equal(b70.p, 0.6);
  const b30 = bins.find((b) => b.lo === 30);
  assert.equal(b30.p, 0);
  assert.ok(b30.ciHigh > 0, "a zero rate at small n still has an honest upper CI");
});

test("the top bin includes 100 exactly (90-100)", () => {
  const bins = computeBins(rows([{ score: 100, outcome: "advanced", count: 3 }]));
  assert.equal(bins.length, 1);
  assert.equal(bins[0].lo, 90);
  assert.equal(bins[0].hi, 100);
});

test("wilson: interval is inside [0,1], contains p, and narrows with n", () => {
  const small = wilson(6, 10);
  const large = wilson(600, 1000);
  assert.ok(small.low >= 0 && small.high <= 1);
  assert.ok(small.low < 0.6 && small.high > 0.6);
  assert.ok(large.high - large.low < small.high - small.low, "more data ⇒ tighter interval");
});

// ---------------------------------------------------------------------------
// Honest display gating
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: calibration is hidden below the minimum total sample", () => {
  const curve = { sampleSize: 12, minTotal: 30, minPerBin: 5, bins: [{ lo: 70, hi: 79, n: 12, advanced: 6, p: 0.5, ciLow: 0.25, ciHigh: 0.75 }] };
  assert.equal(calibrationForScore(curve, 72), null);
});

test("ACCEPTANCE GATE: calibration is hidden for a thin bin even when the total is large", () => {
  const curve = {
    sampleSize: 100,
    minTotal: 30,
    minPerBin: 5,
    bins: [
      { lo: 70, hi: 79, n: 3, advanced: 2, p: 0.667, ciLow: 0.2, ciHigh: 0.93 },
      { lo: 40, hi: 49, n: 97, advanced: 20, p: 0.206, ciLow: 0.14, ciHigh: 0.29 },
    ],
  };
  assert.equal(calibrationForScore(curve, 75), null, "thin bin hidden");
  const shown = calibrationForScore(curve, 45);
  assert.ok(shown);
  assert.equal(shown.probability, 0.206);
  assert.equal(shown.n, 97);
});

// ---------------------------------------------------------------------------
// Outcome capture semantics
// ---------------------------------------------------------------------------

test("outcomeForStage: shortlisted and beyond are 'advanced'; earlier stages pending; rejected rejected", () => {
  assert.equal(outcomeForStage("applied"), "pending");
  assert.equal(outcomeForStage("ats_passed"), "pending");
  assert.equal(outcomeForStage("ai_interview_completed"), "pending");
  assert.equal(outcomeForStage("under_review"), "pending");
  assert.equal(outcomeForStage("shortlisted"), "advanced");
  assert.equal(outcomeForStage("hr_interview"), "advanced");
  assert.equal(outcomeForStage("offer_accepted"), "advanced");
  assert.equal(outcomeForStage("rejected"), "rejected");
  assert.equal(outcomeForStage("interview_queue"), "pending", "legacy stage names normalise");
  assert.equal(outcomeForStage("next_round"), "advanced", "legacy shortlisted alias counts");
});

test("nextOutcome: a decided milestone never changes", () => {
  assert.equal(nextOutcome("pending", "advanced"), "advanced");
  assert.equal(nextOutcome("pending", "rejected"), "rejected");
  assert.equal(nextOutcome("advanced", "rejected"), "advanced", "a later rejection doesn't un-happen advancement");
  assert.equal(nextOutcome("rejected", "advanced"), "rejected");
  assert.equal(nextOutcome("pending", "pending"), "pending");
});

// ---------------------------------------------------------------------------
// Criterion insights (10.4)
// ---------------------------------------------------------------------------

test("classifyCriterion: predictive / no-signal / inverse / insufficient", () => {
  assert.equal(
    classifyCriterion({ nAdvanced: 20, nRejected: 20, satisfiedAdvanced: 18, satisfiedRejected: 6 }).insight,
    "predictive"
  );
  assert.equal(
    classifyCriterion({ nAdvanced: 20, nRejected: 20, satisfiedAdvanced: 12, satisfiedRejected: 12 }).insight,
    "no_signal"
  );
  assert.equal(
    classifyCriterion({ nAdvanced: 20, nRejected: 20, satisfiedAdvanced: 6, satisfiedRejected: 16 }).insight,
    "inverse"
  );
  assert.equal(
    classifyCriterion({ nAdvanced: 5, nRejected: 4, satisfiedAdvanced: 5, satisfiedRejected: 0 }).insight,
    "insufficient_data"
  );
  assert.ok(INSIGHT_MIN_N >= 20, "insights require a real sample");
});

// ---------------------------------------------------------------------------
// GUARDRAIL: weights provably unmodifiable by outcome data
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: the scorer has zero calibration dependency (calibration is display-only)", () => {
  const scorerSrc = fs.readFileSync(path.join(__dirname, "../../utils/evidenceScorer.js"), "utf8");
  assert.ok(!/calibration/i.test(scorerSrc), "evidenceScorer must never mention calibration");
  assert.ok(!/ScoreOutcome/.test(scorerSrc), "evidenceScorer must never read outcomes");
});

test("ACCEPTANCE GATE: the calibration service never writes a rubric (no auto-tuning path exists)", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../services/calibrationService.js"), "utf8");
  // RoleRubric appears only as a read (findOne); no save/update/insert on it.
  assert.ok(!/RoleRubric\s*\.\s*(updateOne|updateMany|findOneAndUpdate|create|insertMany|replaceOne|bulkWrite)/.test(src));
  assert.ok(!/rubric\.(save|set)\(/.test(src), "no rubric document mutation");
  const outcomeSrc = fs.readFileSync(path.join(__dirname, "../../services/scoreOutcomeService.js"), "utf8");
  assert.ok(!/RoleRubric/.test(outcomeSrc.replace(/ref: "RoleRubric"/g, "")), "outcome capture never touches rubrics");
});
