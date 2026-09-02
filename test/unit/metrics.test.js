// Unit tests for the eval metric computations — hand-computed expectations.
// If the ruler is wrong, every measurement after it is noise.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const m = require("../eval/metrics");

test("classificationMetrics: three-class confusion, precision/recall/F1", () => {
  const results = [
    { expected: "pass", actual: "pass" },
    { expected: "pass", actual: "fail" },
    { expected: "fail", actual: "fail" },
    { expected: "review", actual: "pass" },
  ];
  const r = m.classificationMetrics(results);
  assert.equal(r.total, 4);
  assert.equal(r.accuracy, 0.5);
  assert.equal(r.confusion.pass.fail, 1);
  assert.equal(r.confusion.review.pass, 1);

  // pass: tp=1, fp=1 (review→pass), fn=1 → P=0.5, R=0.5, F1=0.5
  assert.equal(r.perClass.pass.precision, 0.5);
  assert.equal(r.perClass.pass.recall, 0.5);
  assert.equal(r.perClass.pass.f1, 0.5);
  // fail: tp=1, fp=1, fn=0 → P=0.5, R=1, F1=2/3
  assert.equal(r.perClass.fail.recall, 1);
  assert.ok(Math.abs(r.perClass.fail.f1 - 2 / 3) < 1e-12);
  // review: never predicted → precision null (0/0), recall 0
  assert.equal(r.perClass.review.precision, null);
  assert.equal(r.perClass.review.recall, 0);
  assert.equal(r.perClass.review.support, 1);
});

test("classificationMetrics: rejects unknown outcomes", () => {
  assert.throws(() => m.classificationMetrics([{ expected: "maybe", actual: "pass" }]));
});

test("reviewRouting: routing rate and borderline capture", () => {
  const results = [
    { expected: "review", actual: "review" },
    { expected: "review", actual: "pass" },
    { expected: "pass", actual: "pass" },
    { expected: "fail", actual: "review" },
  ];
  const r = m.reviewRouting(results);
  assert.equal(r.routingRate, 0.5); // 2 of 4 routed
  assert.equal(r.borderlineCapture, 0.5); // 1 of 2 expected-review captured
  assert.equal(r.expectedReviewCount, 2);
});

test("spanValidity: exact slice match only; n/a is null, never 100%", () => {
  const src = "Hello world resume text";
  const r = m.spanValidity([
    { quote: "world", start: 6, end: 11, sourceText: src }, // valid
    { quote: "world", start: 5, end: 10, sourceText: src }, // off by one → invalid
    { quote: "kubernetes", start: 0, end: 10, sourceText: src }, // fabricated → invalid
  ]);
  assert.equal(r.total, 3);
  assert.equal(r.valid, 1);
  assert.ok(Math.abs(r.rate - 1 / 3) < 1e-12);
  assert.equal(r.invalid.length, 2);

  // An engine that emits no spans is NOT 100% valid — it is unmeasured.
  assert.equal(m.spanValidity([]).rate, null);
  assert.equal(m.spanValidity(null).rate, null);
});

test("reproducibility: identical runs vs unstable runs", () => {
  const stable = m.reproducibility([[70, 70, 70], [65, 65, 65]]);
  assert.equal(stable.identical, true);
  assert.equal(stable.maxRange, 0);
  assert.equal(stable.unstableCases.length, 0);

  const unstable = m.reproducibility([[70, 71, 70]]);
  assert.equal(unstable.identical, false);
  assert.equal(unstable.maxRange, 1);
  assert.equal(unstable.unstableCases.length, 1);
});

test("decisionAgreement: unanimous and pairwise rates", () => {
  const r = m.decisionAgreement([
    ["pass", "pass"],
    ["pass", "fail"],
  ]);
  assert.equal(r.unanimousRate, 0.5);
  assert.equal(r.meanPairwiseAgreement, 0.5);
});

test("latencyStats: p50/p95 on a known distribution", () => {
  const durations = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  const r = m.latencyStats(durations);
  assert.equal(r.p50, 50);
  assert.equal(r.p95, 100);
  assert.equal(r.mean, 55);
  assert.equal(m.latencyStats([]).p50, null);
});

test("costStats: totals and per-candidate", () => {
  const r = m.costStats(
    [
      { promptTokens: 100, completionTokens: 50, costCents: 0.5 },
      { promptTokens: 200, completionTokens: 100, costCents: 1.5 },
    ],
    4
  );
  assert.equal(r.llmCalls, 2);
  assert.equal(r.totalPromptTokens, 300);
  assert.equal(r.totalCostCents, 2);
  assert.equal(r.costPerCandidateCents, 0.5);
  assert.equal(m.costStats([], 0).costPerCandidateCents, null);
});
