// The legacy deterministic engine run against the golden set. This does NOT
// assert accuracy — the legacy engine's misses on the adversarial buckets are
// expected and recorded by the eval baseline, not hidden by a test. What it DOES
// assert is what the Phase 1 acceptance gate demands:
//   1. exact reproducibility (variance 0 — proves the harness is sound before an
//      LLM is anywhere near the loop),
//   2. structural sanity of the engine output,
//   3. the labels aren't inverted (clear_pass outscores clear_fail on average),
//   4. the enforced bias dimensions show zero delta on the legacy engine.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { loadGoldenSet } = require("../eval/goldenSet");
const { computeAtsScore } = require("../../utils/atsEngine");
const { reproducibility } = require("../eval/metrics");
const { runBiasProbe } = require("../eval/bias");

const cases = loadGoldenSet();
const REPEATS = 5;

test("legacy engine is exactly reproducible: 5 runs per case, variance 0", () => {
  const runs = cases.map((c) =>
    Array.from({ length: REPEATS }, () => computeAtsScore(c.job, c.candidate, c.resumeText).overallScore)
  );
  const r = reproducibility(runs);
  assert.equal(r.identical, true, `unstable cases: ${JSON.stringify(r.unstableCases)}`);
  assert.equal(r.maxRange, 0);
});

test("legacy engine output is structurally sane on every case", () => {
  for (const c of cases) {
    const r = computeAtsScore(c.job, c.candidate, c.resumeText);
    for (const field of ["skillsMatch", "experienceMatch", "educationMatch", "projectsMatch", "certificationMatch", "keywordMatch", "overallScore"]) {
      assert.ok(Number.isFinite(r[field]) && r[field] >= 0 && r[field] <= 100, `${c.id}: ${field}=${r[field]} out of range`);
    }
    assert.ok(["pass", "fail"].includes(r.decision), `${c.id}: decision=${r.decision}`);
    assert.ok(Array.isArray(r.missingSkills), `${c.id}: missingSkills must be an array`);
  }
});

test("labels are not inverted: clear_pass outscores clear_fail on average", () => {
  const mean = (bucket) => {
    const scores = cases.filter((c) => c.bucket === bucket).map((c) => computeAtsScore(c.job, c.candidate, c.resumeText).overallScore);
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  };
  const passMean = mean("clear_pass");
  const failMean = mean("clear_fail");
  assert.ok(passMean > failMean, `clear_pass mean ${passMean} must exceed clear_fail mean ${failMean} — labels or fixtures are broken`);
});

test("bias probe on the legacy engine: enforced dimensions (name, pronoun, gradYear) show zero delta", () => {
  const probe = runBiasProbe({
    cases,
    scoreFn: computeAtsScore,
    enforce: ["name", "pronoun", "gradYear"],
    report: ["university"],
    tolerance: 0,
  });
  for (const dim of ["name", "pronoun", "gradYear"]) {
    const d = probe.dimensions[dim];
    assert.equal(d.pass, true, `${dim}: ${JSON.stringify(d.offenders.slice(0, 5))}`);
    assert.equal(d.maxAbsDelta, 0, `${dim} leaked into the score`);
  }
  assert.equal(probe.pass, true);

  // University tier is REPORT-ONLY for the legacy engine: its education matcher
  // tokenises institution names, a known prestige leak. We surface it honestly
  // here; the Phase 6 engine must drive it to zero and move it to enforced.
  const uni = probe.dimensions.university;
  assert.ok(uni.variantsScored > 0, "university dimension must actually run");
  console.log(
    `[bias][report-only] university-tier maxAbsDelta on legacy engine: ${uni.maxAbsDelta} ` +
      `(${uni.offenders.length} variant scores moved) — known legacy deficiency, Phase 6 must eliminate`
  );
});
