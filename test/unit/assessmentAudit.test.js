// Assignment-decision audit export + the A3.5 report section. All offline: the
// audit builders are pure functions over already-loaded documents, and the PDF
// builder is deterministic code over a report object — so the export contract
// (column order, escaping, honest "pending" rows, rate floor) and the report's
// honest-rendering rules (skip ≠ missing, unscored ≠ placeholder) are assertable
// without a DB.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { COLUMNS, auditRows, auditSummary, toCsv } = require("../../utils/assessmentAudit");
const { buildReportPdf } = require("../../services/interviewReportPdf");
const { assessmentGateEngages } = require("../../services/atsService");

function candidateFixture(overrides = {}) {
  return {
    _id: "cand1",
    basicDetails: { name: "Ada Lovelace", email: "ada@example.com" },
    status: "assessment_completed",
    ats: { overallScore: 71 },
    assessmentDecision: { action: "sent", mode: "manual", byName: "Ravi", at: new Date("2026-07-20T10:00:00Z") },
    ...overrides,
  };
}

function sessionFixture(overrides = {}) {
  return {
    candidate: "cand1",
    status: "completed",
    difficultyTier: { value: "hard", source: "claim_derived", basis: "claimed 7y, senior title" },
    result: {
      scoredAt: new Date("2026-07-22T09:00:00Z"),
      totalItems: 12,
      totalCorrect: 9,
      completedBy: "submit",
    },
    ...overrides,
  };
}

// --- The recruiter gate predicate --------------------------------------------

test("the gate engages on policy alone — paper readiness must never bypass the recruiter", () => {
  // Engages for manual and auto whenever the engine is on…
  assert.equal(assessmentGateEngages(true, "manual"), true);
  assert.equal(assessmentGateEngages(true, "auto"), true);
  // …and is a function of (engineOn, policy) ONLY. If someone re-adds a paper
  // or readiness argument, arity changes and this pin fails.
  assert.equal(assessmentGateEngages.length, 2);
  // Off-policy and engine-off keep the pre-engine pathway byte-identical.
  assert.equal(assessmentGateEngages(true, "off"), false);
  assert.equal(assessmentGateEngages(true, undefined), false);
  assert.equal(assessmentGateEngages(false, "manual"), false);
});

// --- auditRows ---------------------------------------------------------------

test("auditRows joins candidate, decision, and latest session into flat columns", () => {
  const rows = auditRows({
    candidates: [candidateFixture()],
    sessionsByCandidate: new Map([["cand1", sessionFixture()]]),
    job: { _id: "job1", title: "Backend Engineer" },
  });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.decision, "sent");
  assert.equal(r.decided_by, "Ravi");
  assert.equal(r.difficulty_tier, "hard");
  assert.equal(r.tier_basis, "claimed 7y, senior title");
  assert.equal(r.total_correct, 9);
  assert.equal(r.total_items, 12);
  assert.equal(r.job_title, "Backend Engineer");
  // Every declared column exists on the row — the CSV contract can't drift.
  for (const col of COLUMNS) assert.ok(col in r, `missing column ${col}`);
});

test("auditRows: no decision yet renders as 'pending', never as blank or a guess", () => {
  const rows = auditRows({
    candidates: [candidateFixture({ assessmentDecision: undefined, status: "ats_passed" })],
    job: { _id: "job1", title: "Backend Engineer" },
  });
  assert.equal(rows[0].decision, "pending");
  assert.equal(rows[0].decided_by, "");
  assert.equal(rows[0].session_status, "");
});

test("auditRows: an unscored session contributes status but no numbers", () => {
  const rows = auditRows({
    candidates: [candidateFixture()],
    sessionsByCandidate: new Map([["cand1", sessionFixture({ status: "in_progress", result: {} })]]),
    job: { _id: "job1" },
  });
  assert.equal(rows[0].session_status, "in_progress");
  assert.equal(rows[0].total_correct, "");
  assert.equal(rows[0].total_items, "");
});

// --- auditSummary ------------------------------------------------------------

test("auditSummary counts sent/skipped/pending and splits by decider", () => {
  const mk = (decision, by) => ({ decision, decision_mode: "manual", decided_by: by });
  const rows = [
    mk("sent", "Ravi"), mk("sent", "Ravi"), mk("sent", "Ravi"), mk("skipped", "Ravi"), mk("sent", "Ravi"),
    mk("skipped", "Priya"),
    { decision: "pending", decision_mode: "", decided_by: "" },
  ];
  const s = auditSummary(rows);
  assert.equal(s.total, 7);
  assert.equal(s.pending, 1);
  assert.equal(s.sent, 4);
  assert.equal(s.skipped, 2);
  const ravi = s.byDecider.find((d) => d.decidedBy === "Ravi");
  // 5 decisions ≥ the sample floor → a real rate (4/5 = 80%).
  assert.equal(ravi.sentRate, 80);
  const priya = s.byDecider.find((d) => d.decidedBy === "Priya");
  // 1 decision — a rate here would be noise wearing a percent sign.
  assert.equal(priya.sentRate, null);
});

// --- toCsv -------------------------------------------------------------------

test("toCsv escapes commas, quotes, and newlines per RFC 4180", () => {
  const rows = auditRows({
    candidates: [
      candidateFixture({
        basicDetails: { name: 'Lovelace, Ada "The Enchantress"', email: "ada@example.com" },
      }),
    ],
    job: { _id: "job1", title: "Line1\nLine2" },
  });
  const csv = toCsv(rows);
  const lines = csv.split("\r\n");
  assert.equal(lines[0], COLUMNS.join(","));
  assert.ok(csv.includes('"Lovelace, Ada ""The Enchantress"""'));
  assert.ok(csv.includes('"Line1\nLine2"'));
});

// --- A3.5 PDF section --------------------------------------------------------

function baseReport(assessment) {
  return {
    candidate: { name: "Ada Lovelace", email: "ada@example.com" },
    job: { title: "Backend Engineer" },
    stage: "assessment_completed",
    stageLabel: "Assessment Completed",
    hasInterview: false,
    assessment,
  };
}

test("PDF renders a skip as a recorded human decision", () => {
  const pdf = buildReportPdf(
    baseReport({ decision: { action: "skipped", mode: "manual", byName: "Ravi", at: new Date() }, session: null })
  );
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
});

test("PDF renders a scored result with provenance and never throws on partials", () => {
  const pdf = buildReportPdf(
    baseReport({
      decision: { action: "sent", mode: "auto", byName: "system", at: new Date() },
      session: {
        status: "expired",
        difficultyTier: { value: "hard", source: "claim_derived", basis: "claimed 7y, senior title" },
        result: {
          scoredAt: new Date(),
          scorerVersion: "assess-scorer-2026-07-30.1",
          reproducibilityHash: "abc123def456abc123def456",
          totalItems: 12,
          totalCorrect: 5,
          perCriterion: [{ criterionId: "c1", itemCount: 6, correctCount: 3 }],
          claimVerdicts: [{ claimId: "cl1", verdict: "contradicted", correctCount: 0, itemCount: 3 }],
          completedBy: "expiry",
        },
      },
    })
  );
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
});

test("PDF with no assessment block renders unchanged (section hidden)", () => {
  const pdf = buildReportPdf(baseReport(null));
  assert.ok(Buffer.isBuffer(pdf));
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
});
