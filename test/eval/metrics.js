// Pure metric computations for the evaluation harness (BUILD-PLAN Phase 1.3).
// Every function here is deterministic and side-effect free so the metrics
// themselves are unit-testable — a harness you can't trust measures nothing.

const OUTCOME_CLASSES = ["pass", "fail", "review"];

/**
 * Three-class classification metrics.
 * results: [{ expected: "pass"|"fail"|"review", actual: "pass"|"fail"|"review" }]
 */
function classificationMetrics(results) {
  const confusion = {};
  for (const e of OUTCOME_CLASSES) {
    confusion[e] = {};
    for (const a of OUTCOME_CLASSES) confusion[e][a] = 0;
  }
  let correct = 0;
  for (const r of results) {
    if (!confusion[r.expected] || confusion[r.expected][r.actual] === undefined) {
      throw new Error(`Unknown outcome in results: expected=${r.expected} actual=${r.actual}`);
    }
    confusion[r.expected][r.actual] += 1;
    if (r.expected === r.actual) correct += 1;
  }

  const perClass = {};
  for (const cls of OUTCOME_CLASSES) {
    const tp = confusion[cls][cls];
    const fn = OUTCOME_CLASSES.reduce((s, a) => s + (a === cls ? 0 : confusion[cls][a]), 0);
    const fp = OUTCOME_CLASSES.reduce((s, e) => s + (e === cls ? 0 : confusion[e][cls]), 0);
    const support = tp + fn;
    const precision = tp + fp === 0 ? null : tp / (tp + fp);
    const recall = support === 0 ? null : tp / support;
    const f1 = precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
    perClass[cls] = { precision, recall, f1, support };
  }

  return {
    total: results.length,
    accuracy: results.length === 0 ? null : correct / results.length,
    confusion,
    perClass,
  };
}

/**
 * Human-review routing metrics.
 * - routingRate: fraction of ALL cases the engine sent to review
 *   (too high = the engine is useless; too low = it is overconfident).
 * - borderlineCapture: of the cases labelled "review", the fraction actually routed
 *   to review — the metric that punishes confident numbers on ambiguous input.
 */
function reviewRouting(results) {
  const total = results.length;
  const routed = results.filter((r) => r.actual === "review").length;
  const expectedReview = results.filter((r) => r.expected === "review");
  const captured = expectedReview.filter((r) => r.actual === "review").length;
  return {
    routingRate: total === 0 ? null : routed / total,
    borderlineCapture: expectedReview.length === 0 ? null : captured / expectedReview.length,
    expectedReviewCount: expectedReview.length,
  };
}

/**
 * Span-validity rate — the direct hallucination metric.
 * extractions: [{ quote, start, end, sourceText }]
 * A span is valid iff sourceText.slice(start, end) === quote (exact, case-sensitive).
 * Engines that emit no spans (the legacy keyword engine) get rate: null — "not
 * applicable" must never be rendered as 100%.
 */
function spanValidity(extractions) {
  if (!extractions || extractions.length === 0) {
    return { total: 0, valid: 0, rate: null };
  }
  let valid = 0;
  const invalid = [];
  for (const ex of extractions) {
    const ok =
      typeof ex.quote === "string" &&
      Number.isInteger(ex.start) &&
      Number.isInteger(ex.end) &&
      ex.start >= 0 &&
      ex.end <= ex.sourceText.length &&
      ex.sourceText.slice(ex.start, ex.end) === ex.quote;
    if (ok) valid += 1;
    else invalid.push({ quote: String(ex.quote).slice(0, 80), start: ex.start, end: ex.end });
  }
  return { total: extractions.length, valid, rate: valid / extractions.length, invalid };
}

/**
 * Reproducibility: same input scored N times.
 * runsPerCase: [[score, score, ...], ...] (one inner array per case)
 * Target for any engine we ship: identical === true (range 0 on every case).
 */
function reproducibility(runsPerCase) {
  let maxRange = 0;
  let sumVariance = 0;
  const unstableCases = [];
  runsPerCase.forEach((runs, i) => {
    const min = Math.min(...runs);
    const max = Math.max(...runs);
    const range = max - min;
    if (range > maxRange) maxRange = range;
    const mean = runs.reduce((a, b) => a + b, 0) / runs.length;
    sumVariance += runs.reduce((a, b) => a + (b - mean) ** 2, 0) / runs.length;
    if (range !== 0) unstableCases.push({ caseIndex: i, runs: [...runs], range });
  });
  return {
    cases: runsPerCase.length,
    runsPerCase: runsPerCase[0] ? runsPerCase[0].length : 0,
    identical: maxRange === 0,
    maxRange,
    meanVariance: runsPerCase.length === 0 ? null : sumVariance / runsPerCase.length,
    unstableCases,
  };
}

/**
 * Inter-sample decision agreement across repeated runs.
 * decisionRunsPerCase: [["pass","pass","review"], ...]
 */
function decisionAgreement(decisionRunsPerCase) {
  if (decisionRunsPerCase.length === 0) return { unanimousRate: null, meanPairwiseAgreement: null };
  let unanimous = 0;
  let pairwiseSum = 0;
  for (const runs of decisionRunsPerCase) {
    const uniq = new Set(runs);
    if (uniq.size === 1) unanimous += 1;
    let agree = 0;
    let pairs = 0;
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        pairs += 1;
        if (runs[i] === runs[j]) agree += 1;
      }
    }
    pairwiseSum += pairs === 0 ? 1 : agree / pairs;
  }
  return {
    unanimousRate: unanimous / decisionRunsPerCase.length,
    meanPairwiseAgreement: pairwiseSum / decisionRunsPerCase.length,
  };
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function latencyStats(durationsMs) {
  return {
    count: durationsMs.length,
    p50: percentile(durationsMs, 50),
    p95: percentile(durationsMs, 95),
    mean: durationsMs.length === 0 ? null : durationsMs.reduce((a, b) => a + b, 0) / durationsMs.length,
  };
}

/**
 * usages: [{ promptTokens, completionTokens, costCents }] — one per LLM call.
 * candidates: how many candidates the run covered (for cost-per-candidate).
 */
function costStats(usages, candidates) {
  const totalCostCents = usages.reduce((a, u) => a + (u.costCents || 0), 0);
  return {
    llmCalls: usages.length,
    totalPromptTokens: usages.reduce((a, u) => a + (u.promptTokens || 0), 0),
    totalCompletionTokens: usages.reduce((a, u) => a + (u.completionTokens || 0), 0),
    totalCostCents,
    costPerCandidateCents: candidates > 0 ? totalCostCents / candidates : null,
  };
}

module.exports = {
  OUTCOME_CLASSES,
  classificationMetrics,
  reviewRouting,
  spanValidity,
  reproducibility,
  decisionAgreement,
  percentile,
  latencyStats,
  costStats,
};
