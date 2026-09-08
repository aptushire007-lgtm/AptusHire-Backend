// Server-side analytics (BUILD-PLAN Phase 12). Everything the landing page
// advertises — pass rates, time-to-hire, score distributions — computed for
// real, tenant-scoped, over date ranges. Plus the evidence-native reports only
// this architecture can produce, and the one-click Bias Audit Pack.

const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const AtsAssessment = require("../models/AtsAssessment");
const InterviewSession = require("../models/InterviewSession");
const ClaimGraph = require("../models/ClaimGraph");
const ReviewItem = require("../models/ReviewItem");
const RoleRubric = require("../models/RoleRubric");
const ScoreOutcome = require("../models/ScoreOutcome");
const CalibrationCurve = require("../models/CalibrationCurve");
const calibrationService = require("../services/calibrationService");
const {
  computeFunnel,
  computeTimeToHire,
  scoreDistribution,
  topEliminators,
  verificationBySkill,
  overrideRates,
  summarizeCounterfactuals,
} = require("../utils/analyticsEngine");

// ?from=YYYY-MM-DD&to=YYYY-MM-DD — defaults to the last 90 days.
function parseRange(req, defaultDays = 90) {
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from ? new Date(req.query.from) : new Date(to.getTime() - defaultDays * 86400000);
  if (isNaN(from.getTime()) || isNaN(to.getTime()) || from > to) {
    const err = new Error("Invalid date range — use from=YYYY-MM-DD&to=YYYY-MM-DD");
    err.status = 400;
    throw err;
  }
  return { from, to };
}

// GET /api/analytics/overview
async function getOverview(req, res) {
  const company = req.user.company;
  const { from, to } = parseRange(req);
  const range = { $gte: from, $lte: to };

  // One round-trip instead of four serial ones. All four are independent, and
  // `.lean()` skips Mongoose document hydration — these rows are only read and
  // aggregated, never saved, so the full model instances were pure overhead.
  const [candidates, assessments, jobCount, interviewsCompleted] = await Promise.all([
    Candidate.find({ company, createdAt: range })
      .select("status stageHistory createdAt ats candidateUser basicDetails.email")
      .lean(),
    AtsAssessment.find({ company, createdAt: range, stage: "pre_interview" })
      .select("overallScore band decision mode")
      .lean(),
    Job.countDocuments({ company }),
    InterviewSession.countDocuments({ company, "aiInterview.completedAt": range }),
  ]);

  const funnel = computeFunnel(candidates);

  // `candidates` here is a list of APPLICATIONS (one Candidate doc = one
  // person↔job). A person applying to three roles must not read as three
  // unique candidates: dedupe on the stable account id, falling back to email
  // (legacy rows) then the doc id (guest applications with neither).
  const applicationCount = candidates.length;
  const uniqueCandidates = new Set(
    candidates.map((c) => String(c.candidateUser || c.basicDetails?.email || c._id))
  ).size;

  const decisions = { pass: 0, review: 0, fail: 0 };
  for (const c of candidates) {
    const d = c.ats?.decision;
    if (decisions[d] !== undefined) decisions[d] += 1;
  }
  const scores = assessments.length
    ? assessments.map((a) => a.overallScore)
    : candidates.map((c) => c.ats?.overallScore).filter((s) => s != null);

  res.json({
    range: { from, to },
    totals: {
      // "candidates" = distinct people (kept as the headline number the UI
      // already reads); "applications" = person↔job rows.
      candidates: uniqueCandidates,
      applications: applicationCount,
      jobs: jobCount,
      interviewsCompleted,
      hires: funnel.stages.find((s) => s.stage === "joined")?.count || 0,
      offersAccepted: funnel.stages.find((s) => s.stage === "offer_accepted")?.count || 0,
    },
    screening: {
      decisions,
      // Rates are per APPLICATION (the right denominator for "% of applications
      // that passed screening"), not per unique candidate.
      passRate: applicationCount ? Math.round((decisions.pass / applicationCount) * 1000) / 1000 : null,
      reviewRate: applicationCount ? Math.round((decisions.review / applicationCount) * 1000) / 1000 : null,
      scoreDistribution: scoreDistribution(scores),
      scoreSource: assessments.length ? "evidence" : "legacy",
    },
    funnel,
    timeToHire: computeTimeToHire(candidates),
  });
}

// GET /api/analytics/evidence — the reports nobody else can produce.
async function getEvidence(req, res) {
  const company = req.user.company;
  const { from, to } = parseRange(req, 365);
  const range = { $gte: from, $lte: to };

  // `.lean()` throughout — this endpoint only reads and aggregates. `qa` was
  // selected but never used (topEliminators reads band + criterionFindings only).
  const [assessments, sessions] = await Promise.all([
    AtsAssessment.find({ company, createdAt: range }).select("band criterionFindings").lean(),
    // Claim-verification outcomes joined to normalised skills (Phase 8 verdicts).
    InterviewSession.find({
      company,
      "aiInterview.probes.0": { $exists: true },
      updatedAt: range,
    })
      .select("candidate aiInterview.probes")
      .lean(),
  ]);
  const candidateIds = sessions.map((s) => s.candidate);
  const graphs = await ClaimGraph.find({ company, candidate: { $in: candidateIds } })
    .sort({ createdAt: -1 })
    .select("candidate claims.id claims.normalized.skill")
    .lean();
  const skillByCandidateClaim = new Map();
  for (const g of graphs) {
    for (const c of g.claims) {
      const key = `${g.candidate}|${c.id}`;
      if (!skillByCandidateClaim.has(key)) skillByCandidateClaim.set(key, c.normalized?.skill || "");
    }
  }
  const probeRows = [];
  for (const s of sessions) {
    for (const p of s.aiInterview.probes) {
      if (p.status !== "assessed") continue;
      probeRows.push({ skill: skillByCandidateClaim.get(`${s.candidate}|${p.claimId}`) || "", verdict: p.verdict });
    }
  }

  // Criteria with no predictive value, across every rubric that has outcomes.
  const rubricIds = await ScoreOutcome.distinct("rubric", { company, rubric: { $ne: null } });
  const scopedRubricIds = rubricIds.slice(0, 20);
  // Reports links each flagged criterion straight to its job's rubric editor
  // ("worth a look in the rubric editor" is a promise, not just copy) — that
  // needs the owning job, which criterionInsights doesn't carry.
  // criterionInsights fires 3 queries each; run the (≤20) rubrics concurrently
  // plus the job lookup and the calibration curve — this loop was the dominant
  // cost of the endpoint when it ran serially (up to 60 round-trips back to back).
  const [rubricJobs, insightsList, curve] = await Promise.all([
    RoleRubric.find({ _id: { $in: rubricIds } }).select("job").lean(),
    Promise.all(
      scopedRubricIds.map((rubricId) =>
        calibrationService.criterionInsights(rubricId, company).catch(() => null)
      )
    ),
    CalibrationCurve.findOne({ company }).lean(),
  ]);
  const jobByRubric = new Map(rubricJobs.map((r) => [String(r._id), String(r.job)]));
  const flaggedCriteria = [];
  scopedRubricIds.forEach((rubricId, i) => {
    const insights = insightsList[i];
    if (!insights) return;
    for (const c of insights.criteria) {
      if (c.insight === "no_signal" || c.insight === "inverse") {
        flaggedCriteria.push({
          rubricId,
          jobId: jobByRubric.get(String(rubricId)) || null,
          rubricVersion: insights.rubricVersion,
          ...c,
        });
      }
    }
  });

  res.json({
    range: { from, to },
    topEliminators: topEliminators(assessments).slice(0, 15),
    claimVerificationBySkill: verificationBySkill(probeRows).slice(0, 25),
    lowValueCriteria: flaggedCriteria,
    calibration: curve
      ? { sampleSize: curve.sampleSize, bins: curve.bins, computedAt: curve.computedAt, shown: curve.sampleSize >= curve.minTotal }
      : null,
  });
}

// GET /api/analytics/audit-pack — the one-click bias-audit export (Phase 12.4).
// The artifact LL144 asks for annually and an EU AI Act conformity assessment
// requests — as a download, not a consulting project.
async function getAuditPack(req, res) {
  const company = req.user.company;
  const { from, to } = parseRange(req, 365);
  const range = { $gte: from, $lte: to };

  // `criterionFindings` folded into this one scan — it used to be a second,
  // identical AtsAssessment query (`detailed`) right after, doubling the read.
  const [assessments, reviewItems, rubrics, outcomes] = await Promise.all([
    AtsAssessment.find({ company, createdAt: range })
      .select(
        "band decision mode stage overallScore qa model promptVersions scorerVersion rubricVersion reproducibilityHash createdAt criterionFindings"
      )
      .lean(),
    ReviewItem.find({ company, createdAt: range }).select("status reasons resolution label createdAt").lean(),
    RoleRubric.find({ company, status: { $in: ["approved", "archived"] } })
      .select("job version status criteria thresholds approvedBy frozenAt compiledBy")
      .lean(),
    ScoreOutcome.find({ company, createdAt: range }).select("score band outcome engine").lean(),
  ]);

  const byBand = { advance: 0, review: 0, decline: 0 };
  for (const a of assessments) if (byBand[a.band] !== undefined) byBand[a.band] += 1;

  // Criterion-level pass rates by score band (the audit's core table).
  const criterionByBand = {};
  for (const a of assessments) {
    for (const f of a.criterionFindings || []) {
      const key = f.label;
      criterionByBand[key] = criterionByBand[key] || { advance: { n: 0, satisfied: 0 }, review: { n: 0, satisfied: 0 }, decline: { n: 0, satisfied: 0 } };
      const cell = criterionByBand[key][a.band];
      if (!cell) continue;
      cell.n += 1;
      if (f.status === "satisfied") cell.satisfied += 1;
    }
  }

  const versionsUsed = {
    models: [...new Set(assessments.map((a) => a.model).filter(Boolean))],
    promptVersions: [...new Set(assessments.flatMap((a) => a.promptVersions || []))],
    scorerVersions: [...new Set(assessments.map((a) => a.scorerVersion).filter(Boolean))],
    rubricVersions: [...new Set(assessments.map((a) => a.rubricVersion).filter((v) => v != null))],
  };

  const counterfactual = summarizeCounterfactuals(assessments);
  const overrides = overrideRates(reviewItems);

  const pack = {
    _title: "Bias Audit Pack — evidence-bound screening engine",
    _description:
      "Machine-generated audit export: rubric provenance, decision distributions, criterion-level pass rates by band, " +
      "live counterfactual bias-probe results, human review + override rates, and full model/prompt/scorer version " +
      "provenance. Every assessment listed carries a reproducibilityHash: identical inputs always produce the " +
      "identical score, and the deterministic scorer is unit-property-tested (see the platform's model card).",
    generatedAt: new Date(),
    period: { from, to },
    scoringDesign: {
      principle: "The model never emits the score — deterministic code computes it from cited evidence.",
      biasControls: [
        "Bias-blinding redaction (names, pronouns, graduation years, university brands) applied BEFORE any model input",
        "Structural counterfactual guarantee: demographic variants produce byte-identical model input",
        "Live sampled counterfactual probes on production traffic (results below)",
        "Timeline gaps recorded, never scored (disparate-impact guardrail)",
        "Review band + human queue: ambiguity routes to people, never to auto-rejection",
        "Calibration is display-only and never feeds scores; weights are never fitted to outcomes",
      ],
    },
    rubrics: rubrics.map((r) => ({
      job: r.job,
      version: r.version,
      status: r.status,
      frozenAt: r.frozenAt,
      approvedByUser: r.approvedBy?.user || null,
      approvedAt: r.approvedBy?.at || null,
      compiledBy: r.compiledBy?.engine,
      thresholds: r.thresholds,
      criteria: r.criteria.map((c) => ({ id: c.id, label: c.label, kind: c.kind, weight: c.weight })),
    })),
    decisions: {
      totalAssessments: assessments.length,
      byBand,
      byMode: {
        shadow: assessments.filter((a) => a.mode === "shadow").length,
        live: assessments.filter((a) => a.mode === "live").length,
      },
      byStage: {
        preInterview: assessments.filter((a) => a.stage === "pre_interview").length,
        postInterview: assessments.filter((a) => a.stage === "post_interview").length,
      },
    },
    criterionPassRatesByBand: criterionByBand,
    counterfactualProbes: {
      ...counterfactual,
      _note: "Each probe re-runs the full model-input pipeline with a swapped demographic marker and asserts byte-identical input. A leak is alerted and routed to review.",
    },
    humanOversight: {
      reviewItemsOpened: reviewItems.length,
      reviewReasons: [...new Set(reviewItems.flatMap((r) => r.reasons || []))],
      ...overrides,
      _note: "Override = a human decision that disagreed with the engine band. These labelled decisions feed calibration display, never scoring.",
    },
    outcomes: {
      decided: outcomes.filter((o) => o.outcome !== "pending").length,
      advanced: outcomes.filter((o) => o.outcome === "advanced").length,
      rejected: outcomes.filter((o) => o.outcome === "rejected").length,
    },
    provenance: {
      ...versionsUsed,
      assessments: assessments.map((a) => ({
        createdAt: a.createdAt,
        stage: a.stage,
        mode: a.mode,
        band: a.band,
        rubricVersion: a.rubricVersion,
        reproducibilityHash: a.reproducibilityHash,
      })),
    },
  };

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="bias-audit-pack-${to.toISOString().slice(0, 10)}.json"`);
  res.send(JSON.stringify(pack, null, 2));
}

// GET /api/analytics/sources — Phase 15.9: per-source funnel quality measured
// by downstream truth (screening pass rate, claim-verification rate, advance
// rate, hires) — never by click volume, and never as a scoring input.
async function getSources(req, res) {
  const company = req.user.company;
  const { from, to } = parseRange(req, 90);
  const range = { $gte: from, $lte: to };

  const candidates = await Candidate.find({ company, createdAt: range })
    .select("source ats stageHistory status")
    .lean();

  const sessions = await InterviewSession.find({
    company,
    candidate: { $in: candidates.map((c) => c._id) },
    "aiInterview.probes.0": { $exists: true },
  })
    .select("candidate aiInterview.probes")
    .lean();
  const probesByCandidate = new Map();
  for (const s of sessions) {
    const assessed = (s.aiInterview?.probes || []).filter((p) => p.status === "assessed");
    if (assessed.length) probesByCandidate.set(String(s.candidate), assessed.map((p) => ({ verdict: p.verdict })));
  }

  const { sourceQuality } = require("../utils/analyticsEngine");
  res.json({ from, to, sources: sourceQuality(candidates, probesByCandidate) });
}

module.exports = { getOverview, getEvidence, getAuditPack, getSources, parseRange };
