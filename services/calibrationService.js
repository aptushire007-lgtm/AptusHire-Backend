// Calibration (BUILD-PLAN Phase 10.2-10.4) — makes the number MEAN something:
// score bins mapped to this tenant's observed advancement rates, with honest
// sample sizes and confidence intervals.
//
// HARD RULES (stated in the product's model card):
//   - Display-only. The scorer never reads calibration; calibration never
//     writes a rubric. Auto-tuning weights from past outcomes would automate
//     past bias — humans read the insights, humans edit the rubric, every
//     edit is a new rubric version.
//   - Never show a calibration built on too little data. Below the minimums
//     the UI shows nothing rather than a fake-precise percentage.
//
// Binning over isotonic regression on purpose: explainable beats sophisticated
// for a number a recruiter has to defend.

const ScoreOutcome = require("../models/ScoreOutcome");
const CalibrationCurve = require("../models/CalibrationCurve");
const AtsAssessment = require("../models/AtsAssessment");
const RoleRubric = require("../models/RoleRubric");

const BIN_WIDTH = 10;

function minTotal() {
  const n = Number(process.env.CALIBRATION_MIN_TOTAL);
  return Number.isFinite(n) && n > 0 ? n : 30;
}
function minPerBin() {
  const n = Number(process.env.CALIBRATION_MIN_BIN);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

// Wilson 95% interval — sane at small n, never leaves [0,1].
function wilson(successes, n) {
  if (n === 0) return { low: 0, high: 1 };
  const z = 1.96;
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Math.max(0, round3(centre - margin)), high: Math.min(1, round3(centre + margin)) };
}

function round3(x) {
  return Math.round(x * 1000) / 1000;
}

/** Pure: decided outcome rows → decile bins with Wilson CIs. */
function computeBins(rows) {
  const bins = [];
  for (let lo = 0; lo < 100; lo += BIN_WIDTH) {
    const hi = lo + BIN_WIDTH === 100 ? 100 : lo + BIN_WIDTH - 1;
    const inBin = rows.filter((r) => r.score >= lo && r.score <= hi);
    if (inBin.length === 0) continue;
    const advanced = inBin.filter((r) => r.outcome === "advanced").length;
    const { low, high } = wilson(advanced, inBin.length);
    bins.push({ lo, hi, n: inBin.length, advanced, p: round3(advanced / inBin.length), ciLow: low, ciHigh: high });
  }
  return bins;
}

/** Recompute + persist the tenant's curve. Returns the curve doc. */
async function computeForCompany(companyId) {
  const rows = await ScoreOutcome.find({ company: companyId, outcome: { $in: ["advanced", "rejected"] } }).select(
    "score outcome"
  );
  const bins = computeBins(rows);
  return CalibrationCurve.findOneAndUpdate(
    { company: companyId },
    {
      company: companyId,
      sampleSize: rows.length,
      bins,
      minTotal: minTotal(),
      minPerBin: minPerBin(),
      computedAt: new Date(),
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

/**
 * Display payload for one score, honestly gated: null when the tenant has too
 * little data overall or in this score's bin. (Pure part exported as
 * `calibrationForScore` for tests.)
 */
function calibrationForScore(curve, score) {
  if (!curve || curve.sampleSize < curve.minTotal) return null;
  const bin = (curve.bins || []).find((b) => score >= b.lo && score <= b.hi);
  if (!bin || bin.n < curve.minPerBin) return null;
  return {
    probability: bin.p,
    n: bin.n,
    ciLow: bin.ciLow,
    ciHigh: bin.ciHigh,
    sampleSize: curve.sampleSize,
    computedAt: curve.computedAt,
    band: { lo: bin.lo, hi: bin.hi },
  };
}

async function getCalibrationForScore(companyId, score) {
  const curve = await CalibrationCurve.findOne({ company: companyId });
  return calibrationForScore(curve, score);
}

// ---------------------------------------------------------------------------
// 10.4 — rubric quality feedback: which criteria actually predicted advancing?
// ---------------------------------------------------------------------------

const INSIGHT_MIN_N = 20;

/** Pure: per-criterion satisfaction rates among advanced vs rejected. */
function classifyCriterion({ nAdvanced, nRejected, satisfiedAdvanced, satisfiedRejected }) {
  const n = nAdvanced + nRejected;
  if (n < INSIGHT_MIN_N || nAdvanced === 0 || nRejected === 0) return { insight: "insufficient_data" };
  const rateAdv = satisfiedAdvanced / nAdvanced;
  const rateRej = satisfiedRejected / nRejected;
  const diff = rateAdv - rateRej;
  if (Math.abs(diff) < 0.05) {
    return {
      insight: "no_signal",
      note: "Advanced and rejected candidates satisfy this criterion at nearly the same rate — it is not driving good decisions. Consider whether it belongs in the rubric.",
    };
  }
  if (diff < -0.1) {
    return {
      insight: "inverse",
      note: "Candidates who FAILED this criterion advanced more often than those who satisfied it — review whether it measures what you think it measures.",
    };
  }
  return { insight: "predictive" };
}

/**
 * Outcome-joined criterion insights for a rubric. READ-ONLY: this function
 * (and this whole service) never writes a rubric — insights go to a human.
 */
async function criterionInsights(rubricId, companyId) {
  const rubric = await RoleRubric.findOne({ _id: rubricId, company: companyId });
  if (!rubric) return null;

  const outcomes = await ScoreOutcome.find({
    company: companyId,
    rubric: rubric._id,
    outcome: { $in: ["advanced", "rejected"] },
  }).select("candidate outcome assessment");
  const outcomeByAssessment = new Map(outcomes.filter((o) => o.assessment).map((o) => [String(o.assessment), o.outcome]));

  const assessments = await AtsAssessment.find({
    _id: { $in: [...outcomeByAssessment.keys()] },
    company: companyId,
  }).select("criterionFindings");

  const stats = new Map(); // criterionId → counters
  for (const a of assessments) {
    const outcome = outcomeByAssessment.get(String(a._id));
    for (const f of a.criterionFindings) {
      if (f.kind === "disqualifier") continue;
      const s = stats.get(f.criterionId) || { nAdvanced: 0, nRejected: 0, satisfiedAdvanced: 0, satisfiedRejected: 0 };
      const satisfied = f.status === "satisfied" ? 1 : 0;
      if (outcome === "advanced") {
        s.nAdvanced += 1;
        s.satisfiedAdvanced += satisfied;
      } else {
        s.nRejected += 1;
        s.satisfiedRejected += satisfied;
      }
      stats.set(f.criterionId, s);
    }
  }

  return {
    rubricId: rubric._id,
    rubricVersion: rubric.version,
    sampleSize: assessments.length,
    criteria: rubric.criteria
      .filter((c) => c.kind !== "disqualifier")
      .map((c) => {
        const s = stats.get(c.id) || { nAdvanced: 0, nRejected: 0, satisfiedAdvanced: 0, satisfiedRejected: 0 };
        const cls = classifyCriterion(s);
        return {
          criterionId: c.id,
          label: c.label,
          weight: c.weight,
          nAdvanced: s.nAdvanced,
          nRejected: s.nRejected,
          satisfiedAdvancedRate: s.nAdvanced ? round3(s.satisfiedAdvanced / s.nAdvanced) : null,
          satisfiedRejectedRate: s.nRejected ? round3(s.satisfiedRejected / s.nRejected) : null,
          ...cls,
        };
      }),
  };
}

module.exports = {
  computeForCompany,
  getCalibrationForScore,
  criterionInsights,
  // pure, for tests
  computeBins,
  wilson,
  calibrationForScore,
  classifyCriterion,
  BIN_WIDTH,
  INSIGHT_MIN_N,
};
