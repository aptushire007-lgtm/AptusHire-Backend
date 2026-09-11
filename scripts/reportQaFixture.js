// Synthetic data only. Run to inspect the report PDF layout, never real applicants.
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { buildReportPdf } = require("../services/interviewReportPdf");
const { reviewReport } = require("../utils/reportPresentation");
const report = {
  candidate: { name: "Synthetic review fixture", email: "fixture@example.invalid" },
  job: { title: "Software Engineer" }, hasInterview: true, stage: "under_review",
  interview: {
    status: "ended_early", engine: "ai", questionCount: 1, maxQuestions: 17,
    startedAt: "2026-09-01T10:00:00Z", completedAt: "2026-09-01T10:03:00Z",
    substance: { responsiveCount: 1, totalAnswers: 2, declinedCount: 0 },
    evaluation: { overallScore: 20, summary: "Unsupported adverse narrative", recommendation: "no_hire", weaknesses: ["Unsupported weakness"], generatedBy: "ai" },
    competencyTriplet: { communication: 10, technicalKnowledge: 20, problemSolving: 30 },
    transcript: [], verdict: { verdict: "CLEAR_REJECT", reason: "Unsupported", confidence: "High" },
  },
};
const dir = join(__dirname, "../tmp/pdfs");
mkdirSync(dir, { recursive: true });
const output = join(dir, "synthetic-review.pdf");
writeFileSync(output, buildReportPdf(reviewReport(report)));
console.log(output);
