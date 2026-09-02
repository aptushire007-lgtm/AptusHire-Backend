const assert = require("node:assert/strict");
const test = require("node:test");
const { buildReportData } = require("../../services/candidateRejectionReportService");

function baseCandidate() {
  return {
    _id: "candidate-1",
    skills: ["Python", "AWS"],
    resumeText: "Python used in a project.",
    experience: [],
    education: [],
    projects: [],
    certificates: [],
    ats: { overallScore: 48, threshold: 60, engine: "evidence" },
  };
}

test("uses the configured ATS threshold as a rejection reason", () => {
  const report = buildReportData({
    candidate: baseCandidate(),
    job: { _id: "job-1", requiredSkills: ["Python", "AWS"], description: "", requirements: "" },
    ats: baseCandidate().ats,
    assessmentSession: null,
    interviewSession: null,
    evidenceAssessment: null,
  });

  assert.match(report.rejectionReasons[0].evidence, /48%.*60%/);
  assert.equal(report.assessmentAnalysis.status, "Not Assessed");
  assert.equal(report.interviewAnalysis.status, "Not Assessed");
});

test("distinguishes a resume claim with weak assessment evidence", () => {
  const report = buildReportData({
    candidate: baseCandidate(),
    job: { _id: "job-1", requiredSkills: ["Python"], description: "", requirements: "" },
    ats: { overallScore: 80, threshold: 60 },
    assessmentSession: { _id: "assessment-1", result: { scoredAt: new Date(), totalItems: 2, totalCorrect: 1, perCriterion: [] } },
    interviewSession: null,
    evidenceAssessment: null,
  });

  const python = report.requirementAnalysis.find((item) => item.requirement === "Python");
  assert.equal(python.status, "Partial Match");
  assert.equal(report.interviewAnalysis.status, "Not Assessed");
});

test("does not fabricate a score when assessment evidence is unavailable", () => {
  const report = buildReportData({
    candidate: { ...baseCandidate(), ats: { overallScore: 70, threshold: 60 } },
    job: { _id: "job-1", requiredSkills: ["Docker"], description: "", requirements: "" },
    ats: { overallScore: 70, threshold: 60 },
    assessmentSession: null,
    interviewSession: null,
    evidenceAssessment: null,
  });

  assert.equal(report.overallAlignment.assessment, null);
  assert.equal(report.overallAlignment.interview, null);
  assert.equal(report.requirementAnalysis[0].status, "No Evidence");
});