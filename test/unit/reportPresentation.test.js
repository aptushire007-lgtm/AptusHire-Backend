const { test } = require("node:test");
const assert = require("node:assert/strict");
const { reviewReport } = require("../../utils/reportPresentation");

for (const guard of [
  { status: "ended_early" },
  { recommendedAction: { suppressed: true, justification: "Audio unavailable" } },
  { evaluation: { reviewReason: "Incomplete evidence" } },
]) {
  test(`report projection keeps the real score but withholds the automated verdict: ${JSON.stringify(guard)}`, () => {
    const raw = { interview: {
      evaluation: { overallScore: 20, summary: "Do not hire", weaknesses: ["Weak"], ...guard.evaluation },
      verdict: { verdict: "CLEAR_REJECT" }, competencyTriplet: { communication: 10 },
      transcript: [{ role: "candidate", text: "Recorded evidence" }], ...guard,
    } };
    const snapshot = structuredClone(raw);
    const shown = reviewReport(raw);
    // The score is the model's actual read of the transcript and is shown as-is; only the
    // automated decision (verdict/recommendation) is withheld, never the evidence itself.
    // (The third guard's `...guard` spread replaces `interview.evaluation` wholesale, so its
    // input never carried overallScore/weaknesses to begin with — compare against the actual
    // input rather than assuming every variant has the same fixture shape.)
    assert.equal(shown.interview.evaluation.overallScore, snapshot.interview.evaluation.overallScore);
    assert.deepEqual(shown.interview.evaluation.weaknesses, snapshot.interview.evaluation.weaknesses);
    assert.equal(shown.interview.evaluation.recommendation, "review");
    assert.equal(shown.interview.verdict.verdict, "REVIEW");
    assert.equal(shown.interview.recommendedAction.suppressed, true);
    assert.equal(shown.interview.competencyTriplet, null);
    assert.deepEqual(raw, snapshot);
    assert.deepEqual(shown.interview.transcript, raw.interview.transcript);
    assert.deepEqual(reviewReport(shown), shown);
  });
}
test("completed measurable reports and no-interview reports retain identity", () => {
  for (const report of [{}, { interview: { status: "completed", evaluation: { overallScore: 0 } } }]) {
    assert.equal(reviewReport(report), report);
  }
});
test("a withheld report without evaluation still cannot show an adverse headline", () => {
  const shown = reviewReport({ interview: { status: "ended_early", verdict: { verdict: "CLEAR_REJECT" } } });
  assert.equal(shown.interview.verdict.verdict, "REVIEW");
  assert.equal(shown.interview.evaluation, undefined);
});

test("PDF output preserves the review projection and distinguishes question counters", () => {
  const { buildReportPdf } = require("../../services/interviewReportPdf");
  const pdf = buildReportPdf(reviewReport({ hasInterview: true, candidate: { name: "Fixture" }, interview: {
    status: "ended_early", questionCount: 1, maxQuestions: 17,
    substance: { responsiveCount: 1, totalAnswers: 2 },
    evaluation: { overallScore: 20, summary: "UNSUPPORTED_NARRATIVE", recommendation: "no_hire" },
  } })).toString("latin1");
  assert.ok(pdf.includes("VERDICT: REVIEW"));
  assert.ok(pdf.includes("Questions recorded"));
  assert.ok(pdf.includes("Planned question maximum"));
  // The score is real evidence and is shown even though the interview ended early; only the
  // model's own narrative and recommendation (which could smuggle in an unreviewed verdict) stay withheld.
  assert.ok(pdf.includes("Overall score: 20/100"));
  assert.ok(!pdf.includes("UNSUPPORTED_NARRATIVE"));
  assert.ok(!pdf.includes("No Hire"));
  assert.ok(pdf.includes("Handle in line with your data-retention policy."));
});

for (const [name, interview, expected, absent] of [
  ["completed zero", { status: "completed", evaluation: { overallScore: 0, summary: "Recorded summary" } }, "Overall score: 0/100", "Overall score: not available"],
  ["completed score", { status: "completed", evaluation: { overallScore: 72, summary: "Recorded summary" } }, "Overall score: 72/100", "Overall score: not available"],
  ["suppressed", { status: "completed", recommendedAction: { suppressed: true }, evaluation: { overallScore: 72, summary: "UNSUPPORTED_HEADLINE" } }, "Overall score: 72/100", "UNSUPPORTED_HEADLINE"],
  ["no evaluation", { status: "ended_early" }, "VERDICT: REVIEW", "Overall score: 0/100"],
]) {
  test(`PDF report matrix: ${name}`, () => {
    const { buildReportPdf } = require("../../services/interviewReportPdf");
    const raw = { hasInterview: true, candidate: { name: "Synthetic fixture" }, interview };
    const before = structuredClone(raw);
    const pdf = buildReportPdf(reviewReport(raw)).toString("latin1");
    assert.ok(pdf.includes(expected));
    assert.ok(!pdf.includes(absent));
    assert.deepEqual(raw, before);
  });
}
test("no-interview PDF does not manufacture a score", () => {
  const { buildReportPdf } = require("../../services/interviewReportPdf");
  const pdf = buildReportPdf({ hasInterview: false, candidate: { name: "Synthetic fixture" } }).toString("latin1");
  assert.ok(pdf.includes("has not completed"));
  assert.ok(!pdf.includes("Overall score:"));
});
