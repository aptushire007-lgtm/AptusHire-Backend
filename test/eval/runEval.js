#!/usr/bin/env node
// Evaluation runner (BUILD-PLAN Phases 1.3–1.5).
//
//   npm run test:eval                 → run, compare against baseline, exit 1 on regression
//   npm run test:eval -- --update-baseline   → intentionally accept the current run as the new baseline
//   npm run test:eval -- --engine legacy --repeats 5
//
// The baseline is how a prompt tweak or model swap can never silently degrade
// screening quality: any tracked metric regressing beyond tolerance fails the run.

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");

const { loadGoldenSet, BUCKET_COUNTS } = require("./goldenSet");
const metrics = require("./metrics");
const { runBiasProbe } = require("./bias");
const { computeAtsScore } = require("../../utils/atsEngine");

const EVAL_DIR = __dirname;
const REPORTS_DIR = path.join(EVAL_DIR, "reports");
const BASELINE_PATH = path.join(EVAL_DIR, "baseline.json");

// Engine registry. Phase 6's evidence engine registers here (shadow → live);
// every engine must expose the SAME entry point production uses.
const ENGINES = {
  legacy: {
    usesLlm: false,
    score: (job, candidate, resumeText) => computeAtsScore(job, candidate, resumeText),
    // Legacy can only say pass/fail — it has no review band. That inability is
    // itself measured (borderlineCapture will be 0) and recorded in the baseline.
    toOutcome: (r) => r.decision,
    extractions: () => [],
    usages: () => [],
  },
};

// Metric → { get(report), tolerance, direction } for baseline comparison.
// direction "up" = higher is better (regression when it drops beyond tolerance).
const TRACKED = [
  { key: "accuracy", get: (r) => r.classification.accuracy, tolerance: 0.02 },
  { key: "pass.f1", get: (r) => r.classification.perClass.pass.f1, tolerance: 0.02 },
  { key: "fail.f1", get: (r) => r.classification.perClass.fail.f1, tolerance: 0.02 },
  { key: "borderlineCapture", get: (r) => r.reviewRouting.borderlineCapture, tolerance: 0.02 },
  { key: "spanValidity.rate", get: (r) => r.spanValidity.rate, tolerance: 0.01 },
  { key: "agreement.unanimousRate", get: (r) => r.agreement.unanimousRate, tolerance: 0 },
];

function parseArgs(argv) {
  const args = { engine: "legacy", repeats: 5, updateBaseline: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--engine") args.engine = argv[++i];
    else if (argv[i] === "--repeats") args.repeats = Number(argv[++i]);
    else if (argv[i] === "--update-baseline") args.updateBaseline = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  if (!ENGINES[args.engine]) throw new Error(`Unknown engine "${args.engine}". Known: ${Object.keys(ENGINES).join(", ")}`);
  if (!Number.isInteger(args.repeats) || args.repeats < 2) throw new Error("--repeats must be an integer >= 2");
  return args;
}

function assertFullGoldenSet(cases) {
  const counts = {};
  for (const c of cases) counts[c.bucket] = (counts[c.bucket] || 0) + 1;
  const problems = [];
  for (const [bucket, want] of Object.entries(BUCKET_COUNTS)) {
    if ((counts[bucket] || 0) !== want) problems.push(`${bucket}: have ${counts[bucket] || 0}, need ${want}`);
  }
  for (const bucket of Object.keys(counts)) {
    if (!(bucket in BUCKET_COUNTS)) problems.push(`unknown bucket "${bucket}"`);
  }
  if (problems.length) {
    throw new Error(`Golden set is incomplete — the eval is only meaningful on the full set:\n  ${problems.join("\n  ")}`);
  }
}

function fmt(v) {
  if (v === null || v === undefined) return "n/a";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const engine = ENGINES[args.engine];
  const cases = loadGoldenSet();
  assertFullGoldenSet(cases);

  console.log(`\n=== Evaluation run — engine: ${args.engine}, cases: ${cases.length}, repeats: ${args.repeats} ===\n`);

  const results = [];
  const scoreRuns = [];
  const decisionRuns = [];
  const durations = [];
  const allExtractions = [];
  const allUsages = [];

  for (const c of cases) {
    const scores = [];
    const decisions = [];
    for (let i = 0; i < args.repeats; i++) {
      const t0 = performance.now();
      const r = engine.score(c.job, c.candidate, c.resumeText);
      durations.push(performance.now() - t0);
      scores.push(r.overallScore);
      decisions.push(engine.toOutcome(r));
      if (i === 0) {
        allExtractions.push(...engine.extractions(r, c));
        allUsages.push(...engine.usages(r));
        results.push({ id: c.id, bucket: c.bucket, expected: c.expected.outcome, actual: engine.toOutcome(r), score: r.overallScore });
      }
    }
    scoreRuns.push(scores);
    decisionRuns.push(decisions);
  }

  const report = {
    engine: args.engine,
    cases: cases.length,
    repeats: args.repeats,
    classification: metrics.classificationMetrics(results),
    reviewRouting: metrics.reviewRouting(results),
    spanValidity: metrics.spanValidity(allExtractions),
    reproducibility: metrics.reproducibility(scoreRuns),
    agreement: metrics.decisionAgreement(decisionRuns),
    latency: metrics.latencyStats(durations),
    cost: metrics.costStats(allUsages, cases.length),
    perCase: results,
  };

  // Bias probe: name/pronoun/gradYear are enforced (delta must be 0); university is
  // report-only for the legacy engine — its education matcher tokenises institution
  // names, a known prestige leak the Phase 6 engine must eliminate (then it moves
  // to the enforced list and becomes a release blocker there too).
  const bias = runBiasProbe({
    cases,
    scoreFn: engine.score,
    enforce: ["name", "pronoun", "gradYear"],
    report: ["university"],
    tolerance: 0,
  });
  report.bias = bias;

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REPORTS_DIR, "eval-report.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(REPORTS_DIR, "bias-report.json"), JSON.stringify(bias, null, 2));

  // ---- Human summary ----
  const c = report.classification;
  console.log(`accuracy:            ${fmt(c.accuracy)}   (${c.total} cases)`);
  for (const cls of ["pass", "fail", "review"]) {
    const m = c.perClass[cls];
    console.log(`${cls.padEnd(8)} P/R/F1:     ${fmt(m.precision)} / ${fmt(m.recall)} / ${fmt(m.f1)}   (support ${m.support})`);
  }
  console.log(`review routing rate: ${fmt(report.reviewRouting.routingRate)}   borderline capture: ${fmt(report.reviewRouting.borderlineCapture)}`);
  console.log(`span validity:       ${report.spanValidity.rate === null ? "n/a (engine emits no spans)" : fmt(report.spanValidity.rate)}`);
  console.log(`reproducibility:     ${report.reproducibility.identical ? "IDENTICAL (variance 0)" : `UNSTABLE — max range ${report.reproducibility.maxRange}`}`);
  console.log(`agreement:           unanimous ${fmt(report.agreement.unanimousRate)}   pairwise ${fmt(report.agreement.meanPairwiseAgreement)}`);
  console.log(`latency:             p50 ${fmt(report.latency.p50)}ms   p95 ${fmt(report.latency.p95)}ms`);
  // Guardrail: the actual dollar cost is ALWAYS printed so nobody loops this accidentally.
  console.log(`TOTAL LLM COST:      $${(report.cost.totalCostCents / 100).toFixed(4)} (${report.cost.llmCalls} LLM calls${engine.usesLlm ? "" : " — deterministic engine, no LLM"})`);

  console.log(`\nBias probe (tolerance ${bias.tolerance}):`);
  for (const [dim, d] of Object.entries(bias.dimensions)) {
    const status = d.enforced ? (d.pass ? "PASS" : "FAIL — RELEASE BLOCKER") : `report-only (maxΔ ${d.maxAbsDelta})`;
    console.log(`  ${dim.padEnd(10)} ${status}   variants ${d.variantsScored}, applicable ${d.applicableCases}, n/a ${d.notApplicableCases}, offenders ${d.offenders.length}`);
  }

  const failures = [];
  if (!bias.pass) {
    for (const [dim, d] of Object.entries(bias.dimensions)) {
      if (d.enforced && !d.pass) {
        failures.push(`bias[${dim}]: ${d.offenders.length} variant(s) moved the score (max |Δ| ${d.maxAbsDelta}) — enforced dimension, release blocker`);
      }
    }
  }

  // ---- Baseline ----
  if (fs.existsSync(BASELINE_PATH) && !args.updateBaseline) {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
    if (baseline.engine !== args.engine) {
      console.log(`\nBaseline is for engine "${baseline.engine}" — skipping metric comparison for engine "${args.engine}".`);
    } else {
      console.log(`\nComparing against baseline (${baseline.createdAt}):`);
      for (const t of TRACKED) {
        const base = t.get(baseline.report);
        const curr = t.get(report);
        if (base === null || base === undefined || curr === null || curr === undefined) {
          console.log(`  ${t.key.padEnd(24)} ${fmt(base)} -> ${fmt(curr)}   (not compared)`);
          continue;
        }
        const regressed = curr < base - t.tolerance;
        console.log(`  ${t.key.padEnd(24)} ${fmt(base)} -> ${fmt(curr)}   ${regressed ? "REGRESSION" : "ok"}`);
        if (regressed) failures.push(`${t.key} regressed: ${fmt(base)} -> ${fmt(curr)} (tolerance ${t.tolerance})`);
      }
      if (baseline.report.reproducibility.identical && !report.reproducibility.identical) {
        failures.push("reproducibility regressed: baseline was variance-0, current run is not");
      }
    }
  }

  if (args.updateBaseline || !fs.existsSync(BASELINE_PATH)) {
    if (failures.length === 0) {
      fs.writeFileSync(BASELINE_PATH, JSON.stringify({ engine: args.engine, createdAt: new Date().toISOString(), report }, null, 2));
      console.log(`\nBaseline ${args.updateBaseline ? "updated" : "created"}: ${path.relative(process.cwd(), BASELINE_PATH)}`);
    } else {
      console.log("\nRefusing to write a baseline from a failing run.");
    }
  }

  if (failures.length) {
    console.error(`\nEVAL FAILED:\n  - ${failures.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(`\nEval OK. Reports written to ${path.relative(process.cwd(), REPORTS_DIR)}\\`);
}

main();
