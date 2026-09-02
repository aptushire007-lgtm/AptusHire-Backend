// Phase 12 acceptance gates — analytics engine (pure computations):
//   - funnel counts stage-reached from the append-only history with honest
//     per-stage conversion;
//   - time-to-hire reports median + mean + n, never a number without hires;
//   - score bins cover 0..100 inclusive;
//   - evidence-native reports: top eliminators (decline band only),
//     claim-verification by skill, engine-vs-human override rates,
//     counterfactual probe summaries.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  computeFunnel,
  computeTimeToHire,
  scoreDistribution,
  topEliminators,
  verificationBySkill,
  overrideRates,
  summarizeCounterfactuals,
} = require("../../utils/analyticsEngine");

function candidate(stages, status = stages[stages.length - 1]) {
  let t = new Date("2026-01-01T00:00:00Z").getTime();
  return {
    status,
    createdAt: new Date(t),
    stageHistory: stages.map((s) => ({ stage: s, at: new Date((t += 86400000)) })),
  };
}

test("computeFunnel: stage-reached counts + conversion from the previous stage", () => {
  const f = computeFunnel([
    candidate(["applied", "ats_passed", "interview_scheduled"]),
    candidate(["applied", "ats_passed"]),
    candidate(["applied", "rejected"], "rejected"),
  ]);
  assert.equal(f.total, 3);
  assert.equal(f.rejected, 1);
  assert.equal(f.stages.find((s) => s.stage === "applied").count, 3);
  assert.equal(f.stages.find((s) => s.stage === "ats_passed").count, 2);
  assert.equal(f.stages.find((s) => s.stage === "interview_scheduled").count, 1);
  assert.equal(f.stages.find((s) => s.stage === "ats_passed").conversionFromPrevious, 0.667);
  assert.equal(f.stages.find((s) => s.stage === "interview_scheduled").conversionFromPrevious, 0.5);
});

test("computeFunnel: legacy stage names normalise (interview_queue → interview_scheduled)", () => {
  const f = computeFunnel([candidate(["applied", "interview_queue"])]);
  assert.equal(f.stages.find((s) => s.stage === "interview_scheduled").count, 1);
});

test("computeTimeToHire: median + mean over completed hires only", () => {
  const hires = [
    candidate(["applied", "offer_accepted"]), // 1 day
    candidate(["applied", "ats_passed", "shortlisted", "offer_accepted"]), // 3 days
    candidate(["applied", "ats_passed"]), // not hired — excluded
  ];
  const t = computeTimeToHire(hires);
  assert.equal(t.n, 2);
  assert.equal(t.medianDays, 2);
  assert.equal(t.meanDays, 2);
  assert.deepEqual(computeTimeToHire([candidate(["applied"])]), { n: 0, meanDays: null, medianDays: null });
});

test("scoreDistribution: decile bins, 100 lands in the top bin, junk ignored", () => {
  const bins = scoreDistribution([0, 5, 55, 95, 100, NaN, "x"]);
  assert.equal(bins.length, 10);
  assert.equal(bins[0].count, 2);
  assert.equal(bins[5].count, 1);
  assert.equal(bins[9].count, 2); // 95 and 100
  assert.equal(bins.reduce((s, b) => s + b.count, 0), 5);
});

test("topEliminators: decline-band absent/contradicted only; disqualifiers excluded", () => {
  const rows = topEliminators([
    {
      band: "decline",
      criterionFindings: [
        { criterionId: "c1", label: "Kafka", kind: "must_have", status: "absent" },
        { criterionId: "c2", label: "Degree", kind: "disqualifier", status: "absent" },
        { criterionId: "c3", label: "SQL", kind: "must_have", status: "satisfied" },
      ],
    },
    { band: "decline", criterionFindings: [{ criterionId: "c1", label: "Kafka", kind: "must_have", status: "contradicted" }] },
    { band: "advance", criterionFindings: [{ criterionId: "c1", label: "Kafka", kind: "must_have", status: "absent" }] },
  ]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], { criterionId: "c1", label: "Kafka", eliminations: 2 });
});

test("verificationBySkill: aggregates verdicts and ranks by contradictions", () => {
  const rows = verificationBySkill([
    { skill: "react", verdict: "verified" },
    { skill: "react", verdict: "contradicted" },
    { skill: "react", verdict: "contradicted" },
    { skill: "kubernetes", verdict: "inconclusive" },
    { skill: "", verdict: "verified" },
  ]);
  assert.equal(rows[0].skill, "react");
  assert.equal(rows[0].probed, 3);
  assert.equal(rows[0].contradicted, 2);
  assert.equal(rows[0].contradictionRate, 0.667);
  assert.ok(rows.some((r) => r.skill === "(unspecified)"));
});

test("overrideRates: humans vs engine, review-band resolutions counted as overrides in neither direction blindly", () => {
  const r = overrideRates([
    { status: "resolved", label: { engineBand: "advance" }, resolution: { decision: "advance" } }, // agree
    { status: "resolved", label: { engineBand: "decline" }, resolution: { decision: "advance" } }, // override up
    { status: "resolved", label: { engineBand: "review" }, resolution: { decision: "decline" } }, // human call on review
    { status: "open", label: { engineBand: "review" } }, // unresolved — excluded
  ]);
  assert.equal(r.resolved, 3);
  assert.equal(r.agree, 1);
  assert.equal(r.overrideAdvance, 1);
  assert.equal(r.overrideDecline, 1);
  assert.equal(r.overrideRate, 0.667);
});

test("summarizeCounterfactuals: ran / identical / leaks", () => {
  const s = summarizeCounterfactuals([
    { qa: { counterfactual: { ran: true, identical: true } } },
    { qa: { counterfactual: { ran: true, identical: false } } },
    { qa: { counterfactual: { ran: false } } },
    {},
  ]);
  assert.deepEqual(s, { ran: 2, identical: 1, leaks: 1 });
});
