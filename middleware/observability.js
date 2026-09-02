// Per-request observability (Wave 6): a correlation id, a request-scoped structured logger,
// a completion access-log, and HTTP metrics — all off one res-finish hook. Register this
// early (before routers) so every request, including 404s and CORS rejections, is measured.

const crypto = require("crypto");
const logger = require("../utils/logger");
const metrics = require("../utils/metrics");

// Health/readiness/metrics are scraped constantly by the LB and Prometheus; logging and
// counting them would drown the signal and inflate the metric cardinality.
const IGNORED_PATHS = new Set(["/api/health", "/api/ready", "/metrics"]);

// Use the matched Express route pattern ("/api/candidates/:id"), never the raw URL, as the
// metric label — otherwise every candidate id becomes its own time series (unbounded
// cardinality). Unmatched requests collapse to a single "unmatched" label.
function routeLabel(req) {
  if (req.route && req.route.path) return `${req.baseUrl || ""}${req.route.path}`;
  return "unmatched";
}

function requestContext(req, res, next) {
  const reqId = req.headers["x-request-id"] || crypto.randomUUID();
  req.id = reqId;
  req.log = logger.child({ reqId });
  res.setHeader("x-request-id", reqId);

  const start = process.hrtime.bigint();
  res.on("finish", () => {
    if (IGNORED_PATHS.has(req.path)) return;
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const route = routeLabel(req);
    metrics.recordHttp({ method: req.method, route, status: res.statusCode, durationMs });
    req.log.info("request", {
      method: req.method,
      path: req.originalUrl,
      route,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      ...(req.user ? { company: req.user.company ? String(req.user.company) : undefined, role: req.user.role } : {}),
    });
  });

  next();
}

// GET /metrics — Prometheus scrape endpoint. Guarded by a bearer token when METRICS_TOKEN
// is set (so a public VPS can't leak internal counters); open in dev when it's unset.
function metricsEndpoint(req, res) {
  const token = process.env.METRICS_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) {
    return res.status(401).end();
  }
  res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  res.send(metrics.render());
}

module.exports = { requestContext, metricsEndpoint };
