const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applicationScreening } = require("../../utils/analyticsEngine");

test("screening counts applications, preserving multiple roles for the same person", () => {
  const result = applicationScreening([
    { candidateUser: "same", ats: { overallScore: 27, decision: "fail", engine: "evidence" } },
    { candidateUser: "same", ats: { overallScore: 70, decision: "pass", engine: "legacy" } },
    { candidateUser: "other", ats: {} },
  ]);
  assert.equal(result.scoreDistribution.reduce((n, b) => n + b.count, 0), 2);
  assert.deepEqual(result.decisions, { pass: 1, review: 0, fail: 1 });
  assert.equal(result.passRate, 0.333);
  assert.equal(result.scoreSource, "mixed");
  assert.equal(result.scoreUnit, "application");
});

test("missing and invalid scores do not become zero-score applications", () => {
  const result = applicationScreening([{ ats: { overallScore: null } }, { ats: { overallScore: "bad" } }, { ats: { overallScore: 0 } }]);
  assert.equal(result.scoreDistribution.reduce((n, b) => n + b.count, 0), 1);
  assert.equal(applicationScreening([]).passRate, null);
});
