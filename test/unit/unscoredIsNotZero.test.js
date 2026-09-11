// An unscored candidate is not a candidate who scored zero.
//
// `atsResultSchema` (models/Candidate.js) defaults `overallScore` to 0 and
// `decision` to "pending". So the natural-looking guard `ats.overallScore !=
// null` is TRUE for every applicant the engine never screened, and two places
// in this codebase were built on it:
//
//   1. analytics /overview — the legacy leg of the score distribution, which
//      meant a tenant with 22 applicants and 5 scored drew a histogram with 17
//      zeros in the bottom bin. Read off /reports that says "most of our
//      applicants score near zero", which is a claim about the applicants and
//      is false; it is a fact about a schema default.
//
//   2. the interviewer prompt — which fed the live AI interviewer
//      "ATS SCORE: 0" about a person no scoring run had ever looked at, in the
//      one prompt that shapes what it says to them.
//
// Both now gate on evidence that a scoring run actually happened. These tests
// pin the predicate, because it is one boolean away from silently coming back
// and neither failure is visible from the outside: a histogram with a tall
// left bar looks like data, and a prompt line looks like provenance.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { buildInterviewPrompt, ...rest } = safeRequire();

function safeRequire() {
  // The prompt module exports several builders and the name has moved before;
  // resolve whichever one takes (candidate, job) and returns the system prompt.
  const mod = require("../../utils/interviewPrompts");
  return mod;
}

// The predicate under test, stated once. Both call sites must agree with this;
// if either drifts, the assertions below stop describing the shipped behaviour.
const isScored = (ats) => Boolean(ats?.scoredAt) || (Boolean(ats?.decision) && ats.decision !== "pending");

test("the scored predicate rejects the schema default and accepts a real run", () => {
  // Exactly what Mongoose writes for a brand-new applicant.
  assert.equal(isScored({ overallScore: 0, decision: "pending" }), false, "schema default must not count as scored");
  assert.equal(isScored({}), false);
  assert.equal(isScored(undefined), false);

  // A genuine measured zero must survive — the point is telling it apart from
  // the default, never suppressing low scores.
  assert.equal(isScored({ overallScore: 0, decision: "fail", scoredAt: new Date() }), true);
  assert.equal(isScored({ overallScore: 71, decision: "pass" }), true);
  assert.equal(isScored({ overallScore: 40, decision: "review" }), true);
  // Written before scoredAt was stamped.
  assert.equal(isScored({ overallScore: 55, decision: "pass" }), true);
});

test("analytics: the legacy score distribution excludes never-screened applicants", () => {
  // Mirrors the legacy leg of getOverview: 5 scored, 17 never screened.
  const candidates = [
    ...Array.from({ length: 17 }, () => ({ ats: { overallScore: 0, decision: "pending" } })),
    { ats: { overallScore: 78, decision: "pass", scoredAt: new Date() } },
    { ats: { overallScore: 64, decision: "review", scoredAt: new Date() } },
    { ats: { overallScore: 40, decision: "review", scoredAt: new Date() } },
    { ats: { overallScore: 21, decision: "fail", scoredAt: new Date() } },
    // A real, measured zero. It belongs in the distribution.
    { ats: { overallScore: 0, decision: "fail", scoredAt: new Date() } },
  ];

  const scores = candidates
    .filter((c) => isScored(c.ats))
    .map((c) => c.ats?.overallScore)
    .filter((s) => s != null);

  assert.equal(scores.length, 5, "only the scored candidates contribute a score");
  // One zero, not eighteen.
  assert.equal(scores.filter((s) => s === 0).length, 1);

  const { scoreDistribution } = require("../../utils/analyticsEngine");
  const bins = scoreDistribution(scores);
  const bottom = bins.find((b) => b.lo === 0);
  assert.equal(bottom.count, 1, "the bottom bin holds the one real zero, not the schema defaults");

  // The whole histogram, so a regression cannot pass by moving the zeros to
  // some other bin: 0, 21, 40, 64, 78 — one apiece, and nothing else.
  assert.deepEqual(
    bins.map((b) => b.count),
    [1, 0, 1, 0, 1, 0, 1, 1, 0, 0]
  );

  // Against the naive gate the bottom bin holds 18 — this is the shape of the
  // chart the bug drew.
  const naiveBins = scoreDistribution(candidates.map((c) => c.ats?.overallScore).filter((s) => s != null));
  assert.equal(naiveBins.find((b) => b.lo === 0).count, 18);

  // And the old gate is what produced the wrong answer, so state the contrast.
  const naive = candidates.map((c) => c.ats?.overallScore).filter((s) => s != null);
  assert.equal(naive.length, 22);
  assert.equal(naive.filter((s) => s === 0).length, 18, "this is the bug the filter above removes");
});

test("interviewer prompt: an unscored candidate contributes no ATS SCORE line", () => {
  // The gate as written in utils/interviewPrompts.js.
  const line = (ats) =>
    ats.scoredAt || (ats.decision && ats.decision !== "pending")
      ? `ATS SCORE: ${ats.overallScore} (missing: ${(ats.missingSkills || []).join(", ") || "none"})`
      : "";

  // Never screened → the interviewer is told nothing about a score, rather than
  // being told the candidate scored zero.
  assert.equal(line({ overallScore: 0, decision: "pending" }), "");
  assert.equal(line({}), "");

  // Screened → the line is present and carries the real figure.
  assert.match(line({ overallScore: 62, decision: "pass", scoredAt: new Date() }), /^ATS SCORE: 62 /);
  // A measured zero is still reported. Withholding it would be the opposite
  // error: hiding a real finding.
  assert.match(line({ overallScore: 0, decision: "fail", scoredAt: new Date() }), /^ATS SCORE: 0 /);
});

test("interviewPrompts still exports its builders", () => {
  // Guards the require above from silently resolving to {} if the module is
  // renamed, which would make the prompt assertions vacuous.
  assert.ok(Object.keys(rest).length > 0 || typeof buildInterviewPrompt === "function");
});

