// Zero-dependency HTTP load tester (Wave 6). Drives N concurrent keep-alive workers at a
// target URL for D seconds, then reports throughput + latency percentiles and checks them
// against the SLO (plan §0). Exits non-zero when the SLO is violated, so it can gate CI.
//
//   npm run loadtest -- --url http://localhost:9000/api/health --concurrency 50 --duration 20
//   node scripts/loadTest.js --url http://localhost:9000/api/jobs/public --concurrency 100 --duration 30
//   node scripts/loadTest.js --url http://localhost:9000/api/jobs --header "Authorization: Bearer <token>"
//
// This is a smoke-scale generator for a pilot, not a distributed load rig. For a real
// pre-launch SLO test use k6/vegeta from a separate host so the client isn't the bottleneck.

const http = require("http");
const https = require("https");
const { URL } = require("url");

function parseArgs(argv) {
  const args = { headers: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    if (key === "header") args.headers.push(val);
    else args[key] = val;
  }
  return args;
}

const args = parseArgs(process.argv);
const target = args.url || process.env.LOADTEST_URL || "http://localhost:9000/api/health";
const concurrency = Number(args.concurrency || process.env.LOADTEST_CONCURRENCY || 50);
const durationSec = Number(args.duration || process.env.LOADTEST_DURATION || 20);
const method = (args.method || "GET").toUpperCase();
const body = args.body || null;

const headers = {};
for (const h of args.headers) {
  const idx = h.indexOf(":");
  if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
}
if (body && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
  headers["Content-Type"] = "application/json";
}

// SLO targets (plan §0). Override via env for a stricter/looser gate.
const SLO = {
  p95Ms: Number(process.env.SLO_P95_MS) || 500,
  p99Ms: Number(process.env.SLO_P99_MS) || 1000,
  errorRatePct: Number(process.env.SLO_ERROR_RATE_PCT) || 1,
};

const u = new URL(target);
const client = u.protocol === "https:" ? https : http;
const agent = new client.Agent({ keepAlive: true, maxSockets: concurrency });

const latencies = [];
const statusCounts = {};
let ok = 0;
let failed = 0;
let done = false;

function oneRequest() {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const req = client.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, headers, agent, timeout: 15000 },
      (res) => {
        res.on("data", () => {});
        res.on("end", () => {
          latencies.push(Number(process.hrtime.bigint() - start) / 1e6);
          statusCounts[res.statusCode] = (statusCounts[res.statusCode] || 0) + 1;
          if (res.statusCode < 400) ok++;
          else failed++;
          resolve();
        });
      }
    );
    req.on("error", () => {
      failed++;
      resolve();
    });
    req.on("timeout", () => {
      req.destroy();
      failed++;
      resolve();
    });
    if (body) req.write(body);
    req.end();
  });
}

async function worker() {
  while (!done) await oneRequest();
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  console.log(`Load test: ${method} ${target}`);
  console.log(`Concurrency: ${concurrency} | Duration: ${durationSec}s\n`);

  const startedAt = Date.now();
  const timer = setTimeout(() => {
    done = true;
  }, durationSec * 1000);
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  clearTimeout(timer);

  const elapsedSec = (Date.now() - startedAt) / 1000;
  const total = ok + failed;
  const sorted = latencies.slice().sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  const maxMs = sorted[sorted.length - 1] || 0;
  const throughput = elapsedSec ? total / elapsedSec : 0;
  const errorRate = total ? (failed / total) * 100 : 0;

  console.log("Results");
  console.log("-------");
  console.log(`Requests:    ${total} (${ok} ok, ${failed} failed)`);
  console.log(`Throughput:  ${throughput.toFixed(1)} req/s`);
  console.log(`Latency ms:  p50=${p50.toFixed(1)}  p95=${p95.toFixed(1)}  p99=${p99.toFixed(1)}  max=${maxMs.toFixed(1)}`);
  console.log(`Errors:      ${errorRate.toFixed(2)}%`);
  console.log(`Status:      ${JSON.stringify(statusCounts)}\n`);

  const checks = [
    ["p95 latency ms", p95, SLO.p95Ms],
    ["p99 latency ms", p99, SLO.p99Ms],
    ["error rate %", errorRate, SLO.errorRatePct],
  ];
  let violated = false;
  console.log("SLO check");
  console.log("---------");
  for (const [name, actual, budget] of checks) {
    const passed = actual <= budget;
    if (!passed) violated = true;
    console.log(`${passed ? "PASS" : "FAIL"}  ${name}: ${actual.toFixed(2)} (budget ${budget})`);
  }
  process.exit(violated ? 1 : 0);
}

main();
