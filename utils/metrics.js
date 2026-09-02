// Minimal in-process metrics registry in Prometheus exposition format — zero dependencies
// (Wave 6 / observability). Tracks HTTP throughput + latency by method/route/status, LLM
// platform counters (Phase 2: breaker state, cache hits, spend), and a few process gauges,
// scraped at GET /metrics. Counters live in the process, so with multiple API instances
// Prometheus scrapes each replica separately and sums — which is the normal multi-target
// model. For nationwide scale, swap for prom-client + a real TSDB.

// Cumulative-count histogram buckets (milliseconds). Chosen around the API SLO (p95 < 500ms).
const BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

// name -> { help, type } — emitted as # HELP / # TYPE headers. Metrics increment fine
// without registration; they just render unannotated.
const META = new Map([
  ["http_requests_total", { help: "Total HTTP requests handled.", type: "counter" }],
  ["http_request_duration_ms", { help: "HTTP request latency in milliseconds.", type: "histogram" }],
  ["llm_requests_total", { help: "LLM calls by outcome (success|error|cache_hit|replay|breaker_open|disabled|no_credits).", type: "counter" }],
  ["llm_request_duration_ms", { help: "Live LLM call latency in milliseconds.", type: "histogram" }],
  ["llm_cost_cents_total", { help: "Cumulative LLM spend in cents (live calls only).", type: "counter" }],
  ["llm_breaker_state", { help: "LLM circuit breaker state: 0=closed, 1=half-open, 2=open.", type: "gauge" }],
  ["llm_breaker_opens_total", { help: "Times the LLM circuit breaker has opened.", type: "counter" }],
  ["llm_credits_exhausted", { help: "1 while the LLM provider account is out of credit (every AI path degraded).", type: "gauge" }],
  ["llm_credit_outages_total", { help: "Distinct LLM credit outages observed (once per outage, not per call).", type: "counter" }],
]);

const counters = new Map(); // name -> Map(labelKey -> count)
const histograms = new Map(); // name -> Map(labelKey -> { labels, buckets:{le:count}, sum, count })
const gauges = new Map(); // name -> Map(labelKey -> value)

function registerMetric(name, type, help) {
  META.set(name, { help, type });
}

function labelKey(labels) {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, "'")}"`)
    .join(",");
}

function series(map, name) {
  if (!map.has(name)) map.set(name, new Map());
  return map.get(name);
}

function incCounter(name, labels = {}, by = 1) {
  const s = series(counters, name);
  const key = labelKey(labels);
  s.set(key, (s.get(key) || 0) + by);
}

function setGauge(name, labels = {}, value) {
  series(gauges, name).set(labelKey(labels), value);
}

function observeHistogram(name, labels, value) {
  const s = series(histograms, name);
  const key = labelKey(labels);
  let h = s.get(key);
  if (!h) {
    h = { buckets: Object.fromEntries(BUCKETS_MS.map((b) => [b, 0])), sum: 0, count: 0 };
    s.set(key, h);
  }
  h.sum += value;
  h.count += 1;
  // A value <= b also satisfies every larger bucket, so increment all buckets >= value:
  // h.buckets[b] is then already the cumulative count Prometheus expects.
  for (const b of BUCKETS_MS) if (value <= b) h.buckets[b] += 1;
}

// The one hook the request middleware calls per finished request.
function recordHttp({ method, route, status, durationMs }) {
  const labels = { method, route, status: String(status) };
  incCounter("http_requests_total", labels);
  observeHistogram("http_request_duration_ms", labels, durationMs);
}

function headerLines(name, fallbackType) {
  const meta = META.get(name);
  const lines = [];
  if (meta?.help) lines.push(`# HELP ${name} ${meta.help}`);
  lines.push(`# TYPE ${name} ${meta?.type || fallbackType}`);
  return lines;
}

function withLabels(name, key) {
  return key ? `${name}{${key}}` : name;
}

function render() {
  const lines = [];

  for (const [name, s] of counters) {
    lines.push(...headerLines(name, "counter"));
    for (const [key, val] of s) lines.push(`${withLabels(name, key)} ${val}`);
  }

  for (const [name, s] of gauges) {
    lines.push(...headerLines(name, "gauge"));
    for (const [key, val] of s) lines.push(`${withLabels(name, key)} ${val}`);
  }

  for (const [name, s] of histograms) {
    lines.push(...headerLines(name, "histogram"));
    for (const [key, h] of s) {
      const base = key ? `${key},` : "";
      for (const b of BUCKETS_MS) lines.push(`${name}_bucket{${base}le="${b}"} ${h.buckets[b]}`);
      lines.push(`${name}_bucket{${base}le="+Inf"} ${h.count}`);
      lines.push(`${name}_sum${key ? `{${key}}` : ""} ${h.sum.toFixed(2)}`);
      lines.push(`${name}_count${key ? `{${key}}` : ""} ${h.count}`);
    }
  }

  const mem = process.memoryUsage();
  lines.push("# HELP process_resident_memory_bytes Resident memory size in bytes.");
  lines.push("# TYPE process_resident_memory_bytes gauge");
  lines.push(`process_resident_memory_bytes ${mem.rss}`);
  lines.push("# HELP nodejs_heap_used_bytes V8 heap used in bytes.");
  lines.push("# TYPE nodejs_heap_used_bytes gauge");
  lines.push(`nodejs_heap_used_bytes ${mem.heapUsed}`);
  lines.push("# HELP process_uptime_seconds Process uptime in seconds.");
  lines.push("# TYPE process_uptime_seconds gauge");
  lines.push(`process_uptime_seconds ${Math.round(process.uptime())}`);

  return lines.join("\n") + "\n";
}

module.exports = { incCounter, setGauge, observeHistogram, recordHttp, render, registerMetric };
