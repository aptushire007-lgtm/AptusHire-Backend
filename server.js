require("dotenv").config();
require("./config/dnsOverride").applyDnsOverride();

const { validateEnv } = require("./config/env");
try {
  validateEnv();
} catch (err) {
  console.error("[server] " + err.message);
  process.exit(1);
}

const http = require("http");
const mongoose = require("mongoose");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const { parseOrigins } = require("./utils/corsOrigins");
const connectDB = require("./config/db");
const { getRedisConnection } = require("./config/redis");

// ── Module registry ──────────────────────────────────────────────────────────
// Reads ENABLED_MODULES from env (default: ats,resume,interview) and provides
// methods to conditionally mount routes, start workers, and schedule crons.
const registry = require("./module-registry");

// ── Core routes (always mounted, regardless of ENABLED_MODULES) ──────────────
const authRoutes = require("./routes/authRoutes");
const companyAuthRoutes = require("./routes/companyAuthRoutes");
const subscriptionRoutes = require("./routes/subscriptionRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const companySettingsRoutes = require("./routes/companySettingsRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const adminNotificationRoutes = require("./routes/adminNotificationRoutes");
const notificationPreferenceRoutes = require("./routes/notificationPreferenceRoutes");
const auditLogRoutes = require("./routes/auditLogRoutes");
const demoRequestRoutes = require("./routes/demoRequestRoutes");
const publicCareersRoutes = require("./routes/publicCareersRoutes");
const platformRoutes = require("./routes/platformRoutes");
const { webhook } = require("./controllers/paymentController");
const { wrapHandler } = require("./middleware/wrapRouter");

// ── Core workers & crons (always started) ────────────────────────────────────
const { initSocket } = require("./config/socket");
const { startEmailWorker } = require("./workers/emailWorker");
const { startPublishWorker } = require("./workers/publishWorker");
const { startSubscriptionExpiryJob } = require("./jobs/subscriptionExpiryJob");
const { startRetentionJob } = require("./jobs/retentionJob");
const { startPublishReconcileJob } = require("./jobs/publishReconcileJob");

// ── Middleware & utilities ────────────────────────────────────────────────────
const { auditLog } = require("./middleware/auditLog");
const { requestContext, metricsEndpoint } = require("./middleware/observability");
const backgroundTasks = require("./utils/backgroundTasks");
const logger = require("./utils/logger");

// Last-resort safety net. This is a single-instance server with no supervisor restarting it
// on crash (nodemon only restarts on file change) — every live interview session and socket
// connection dies with the process. A rejected promise that misses an `await`/`.catch` (e.g. a
// third-party API resetting a connection mid-request) must not take the whole server down for
// every candidate over one request; log it and keep serving. Route-level errors should still be
// caught by asyncHandler + the global Express error middleware below — this only catches what
// slips past that (background jobs, cron, socket handlers).
// As of Phase 0.3 every router is wrapped by middleware/wrapRouter, so a rejection from a
// route handler now reaches the Express error handler below. Anything arriving HERE is
// therefore genuinely unhandled — a background job, a cron tick, or a socket handler — and
// the process is in an unknown state.
//
// In development, keep serving so nodemon sessions aren't disrupted. In production, exit
// non-zero so the supervisor restarts a known-good process: a zombie that logs errors while
// silently failing requests is worse than a restart. Exit via shutdown() so in-flight
// requests drain first.
process.on("unhandledRejection", (reason) => {
  logger.error("unhandled promise rejection", {
    err: reason instanceof Error ? { message: reason.message, stack: reason.stack } : { value: String(reason) },
  });
  if (process.env.NODE_ENV === "production") shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (err) => {
  logger.error("uncaught exception", { err: { message: err.message, stack: err.stack } });
  if (process.env.NODE_ENV === "production") shutdown("uncaughtException", 1);
});

const app = express();
app.set("trust proxy", 1); // behind Nginx/Caddy — req.ip reflects the real client, not the proxy

// Security headers. This is a JSON API (+ file downloads to the SPAs on other origins),
// so relax Cross-Origin-Resource-Policy to allow the admin/user apps to load resources
// (e.g. identity photos) cross-origin; keep the rest of helmet's defaults.
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);
app.use(compression());

// Observability: assign a correlation id + request-scoped logger, then log + meter every
// request on finish. Registered before cors/routers so 404s and CORS rejections are counted.
app.use(requestContext);

app.use(
  cors({
    origin: parseOrigins(process.env.CLIENT_ORIGIN_ADMIN, process.env.CLIENT_ORIGIN_USER),
  })
);

// Razorpay webhook signature verification needs the exact raw request bytes,
// so this route is registered with a raw-body parser ahead of the global
// express.json() middleware below (which would otherwise consume the stream
// and reserialize it, breaking signature verification).
app.post(
  "/api/payments/webhook",
  express.raw({ type: "application/json", limit: process.env.RAZORPAY_WEBHOOK_BODY_LIMIT || "256kb" }),
  (req, res, next) => {
    req.rawBody = req.body;
    try {
      req.body = JSON.parse(req.body.toString("utf8"));
    } catch {
      req.body = {};
    }
    next();
  },
  wrapHandler(webhook)
);

// Module-specific raw-body webhooks (e.g., LiveKit room_finished for the interview module).
// These must also be registered before express.json() for signature verification.
// Only mounts webhooks for enabled modules (ENABLED_MODULES env var).
registry.mountRawWebhooks(app, express);

// Bounded JSON body — resumes/photos go through multer (multipart), so a small limit
// here is safe and caps a cheap DoS vector (huge JSON bodies). Configurable via env.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || "1mb" }));

// Audit trail: records every authenticated mutating request (who/what/tenant/outcome)
// once the response finishes. Registered before the routers so its res-finish hook is
// in place; it no-ops for anonymous/GET traffic. See middleware/auditLog.js.
app.use(auditLog);

// Root + plain health — for a human (or Railway/UptimeRobot) hitting the base
// URL, and so `GET /` is a deliberate 200 instead of falling through to the API
// 404. Registered here, ahead of the careers router (mounted at "/") and the
// 404 handler. No env, no dependency checks, nothing sensitive — the real
// dependency probe stays at /api/ready.
app.get("/", (req, res) => res.json({ status: "ok", message: "AptusHire API is running" }));
app.get("/health", (req, res) => res.status(200).json({ status: "healthy" }));

// Liveness: is the process up? (used by the LB/orchestrator to decide restart)
app.get("/api/health", (req, res) => res.json({ ok: true, modules: registry.getEnabledModules() }));

// Readiness: can this instance actually serve traffic? Checks its dependencies so the
// LB stops routing to an instance whose Mongo/Redis is down instead of failing requests.
app.get("/api/ready", (req, res) => {
  const mongoReady = mongoose.connection.readyState === 1;
  const redis = getRedisConnection();
  const redisReady = !redis || redis.status === "ready"; // Redis optional in dev
  const ready = mongoReady && redisReady;
  res.status(ready ? 200 : 503).json({ ready, mongo: mongoReady, redis: redisReady });
});

// Prometheus scrape endpoint (token-guarded when METRICS_TOKEN is set). See middleware/observability.js.
app.get("/metrics", metricsEndpoint);

// ── Core routes (always mounted) ─────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/companies", companyAuthRoutes);
app.use("/api/subscriptions", subscriptionRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/company-settings", companySettingsRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/admin-notifications", adminNotificationRoutes);
app.use("/api/notification-preferences", notificationPreferenceRoutes);
app.use("/api/audit-logs", auditLogRoutes);
app.use("/api/demo-requests", demoRequestRoutes);
app.use("/api/platform", platformRoutes);

// ── Module routes (conditionally mounted based on ENABLED_MODULES) ───────────
// The registry reads module manifests and mounts routes only for enabled modules.
// Example: ENABLED_MODULES=interview mounts only interview routes — no ATS, no resume.
registry.mountRoutes(app);

// Phase 15.2/15.3 — public, crawler-facing careers pages + job feeds (root
// paths, not /api: these URLs are submitted to aggregators and indexed).
app.use("/", publicCareersRoutes);

// 404 — this is a JSON API, so an unmatched path must not fall through to Express's
// default HTML error page (which a fetch()/axios caller can only report as a parse error).
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

// Programming / infrastructure faults. These are OUR bug or a dependency being down, never
// something the caller can fix by changing their request, so they must surface as 5xx —
// otherwise a Mongo outage is indistinguishable from a validation error, both on the client
// and in the Prometheus `status` label (which is how an outage stays invisible on a dashboard).
const SERVER_FAULTS = new Set(["TypeError", "ReferenceError", "SyntaxError", "RangeError"]);
function isServerFault(err) {
  if (SERVER_FAULTS.has(err.name)) return true;
  if (typeof err.name === "string" && err.name.startsWith("Mongo")) return true; // MongoServerError, MongoNetworkError, ...
  return ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(err.code);
}

app.use((err, req, res, next) => {
  // Contract preserved (see CLAUDE.md): a controller may `throw new Error("...")` for a
  // caller-fixable problem and get a 400 with that message. We only override that default
  // when the error carries an explicit status, or when it is clearly a server fault.
  let status = Number(err.status || err.statusCode) || 0;
  if (!status) {
    if (err.name === "ValidationError" || err.name === "CastError") status = 400; // mongoose
    else status = isServerFault(err) ? 500 : 400;
  }

  const log = req.log || logger;
  const detail = { err: { name: err.name, message: err.message, stack: err.stack }, path: req.originalUrl, status };
  if (status >= 500) log.error("request failed", detail);
  else log.warn("request rejected", { ...detail, err: { name: err.name, message: err.message } });

  // Response already started (e.g. a stream failed mid-flight) — let Express close it.
  if (res.headersSent) return next(err);

  // Never leak an internal message/stack for a server fault; hand back the correlation id
  // so a support request can be tied to the log line that has the detail.
  if (status >= 500) {
    return res.status(status).json({ error: "Something went wrong", requestId: req.id });
  }
  // Machine-readable business errors (Phase 11.3): quota/subscription blocks
  // carry a stable `code` (+ structured detail) so clients can react instead of
  // string-matching a message.
  const body = { error: err.message || "Something went wrong" };
  if (err.code && typeof err.code === "string" && /^[A-Z_]+$/.test(err.code)) body.code = err.code;
  if (err.quota) body.quota = err.quota;
  if (err.subscription) body.subscription = err.subscription;
  res.status(status).json(body);
});

const PORT = process.env.PORT || 9000;
const httpServer = http.createServer(app);

// Bound how long a socket may take sending headers / the whole request, so a slow or
// stuck client (Slowloris-style) can't tie up a connection indefinitely. headersTimeout
// must exceed requestTimeout. Values in ms; tunable via env.
httpServer.requestTimeout = Number(process.env.REQUEST_TIMEOUT_MS) || 30000;
httpServer.headersTimeout = Number(process.env.HEADERS_TIMEOUT_MS) || 35000;

// Background jobs (email worker + cron) run IN the API process by default, which is
// correct for single-instance dev/pilot. For multi-instance production, set
// RUN_WORKERS_IN_API=false on the API instances and run one `npm run worker` process,
// so cron fires exactly once (avoids the duplicate-email double-fire at N replicas).
const runWorkersInApi = process.env.RUN_WORKERS_IN_API !== "false";
let emailWorker = null;

connectDB()
  .then(() => {
    initSocket(httpServer);
    // Item-generation runs live in process memory, so any that were mid-flight when
    // this process's predecessor died are never going to finish. Release them (only
    // the ones whose heartbeat has gone quiet — a peer instance's live run is left
    // alone) so the paper reports the interruption and the recruiter can resume,
    // instead of the editor spinning on a run that no longer exists.
    require("./services/itemGenService")
      .reconcileInterruptedRuns()
      .catch((err) => logger.error("failed to reconcile interrupted item-generation runs", { err: { message: err.message } }));
    if (runWorkersInApi) {
      // Core workers & crons (always started)
      emailWorker = startEmailWorker();
      startPublishWorker();
      startSubscriptionExpiryJob();
      startRetentionJob();
      startPublishReconcileJob();

      // Module-specific workers & crons (only for enabled modules)
      registry.startWorkers();
      registry.startCrons();
    } else {
      logger.info("RUN_WORKERS_IN_API=false — email worker + cron run in the separate worker process");
    }
    httpServer.listen(PORT, () => logger.info("server listening", { port: PORT }));
  })
  .catch((err) => {
    logger.error("failed to connect to MongoDB", { err: { message: err.message } });
    process.exit(1);
  });

// Graceful shutdown: stop accepting new connections, then drain sockets, background
// work, worker, and DB. Without this, a rolling deploy/autoscale-down kills in-flight
// requests and jobs.
//
// Budgets are sized for the platform's SIGTERM→SIGKILL window, which is what actually
// bounds us (Render allows ~30s). SHUTDOWN_DRAIN_MS is how long detached work gets;
// SHUTDOWN_TIMEOUT_MS is the hard stop for the whole sequence and must exceed it with
// room for the socket/worker/Mongo teardown that follows.
const SHUTDOWN_DRAIN_MS = Number(process.env.SHUTDOWN_DRAIN_MS) || 15000;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 25000;
let shuttingDown = false;
// `code` is the exit status on a CLEAN drain: 0 for an operator-initiated signal, 1 when we
// are bailing out of a broken state (unhandledRejection/uncaughtException) so the supervisor
// treats it as a crash and restarts rather than assuming an intentional stop.
async function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("shutting down gracefully", { signal, exitCode: code });
  const forceExit = setTimeout(() => {
    logger.error("forced exit", { afterMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  try {
    if (httpServer && httpServer.listening) await new Promise((resolve) => httpServer.close(resolve));

    // Closing the HTTP server resolves immediately for work that already answered its
    // request — apply screens after its 201, rescore after its 202, an interview
    // finalises after the candidate's last answer. Disconnecting Mongo underneath those
    // kills them mid-write, and silently: the alert path inside each one needs the same
    // connection. Give them a bounded window first.
    if (backgroundTasks.pendingCount() > 0) {
      logger.info("draining background tasks", { pending: backgroundTasks.pendingCount(), budgetMs: SHUTDOWN_DRAIN_MS });
      const { drained, abandoned } = await backgroundTasks.drain(SHUTDOWN_DRAIN_MS);
      // A live-mode screen is several LLM calls and can outlast any drain budget a
      // SIGTERM allows. When that happens the work IS lost — so name it, because the
      // recovery is a human re-running "Rescore" on exactly these records.
      if (!drained) logger.error("background tasks abandoned at shutdown — re-run these", { abandoned });
      else logger.info("background tasks drained");
    }

    const { getIO } = require("./config/socket");
    getIO()?.close();
    if (emailWorker) await emailWorker.close();
    await mongoose.disconnect();
    clearTimeout(forceExit);
    logger.info("shutdown complete");
    process.exit(code);
  } catch (err) {
    logger.error("error during shutdown", { err: { message: err.message } });
    process.exit(1);
  }
}
["SIGTERM", "SIGINT"].forEach((sig) => process.on(sig, () => shutdown(sig)));
