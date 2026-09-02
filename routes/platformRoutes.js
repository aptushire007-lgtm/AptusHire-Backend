// /api/platform/* (BUILD-PLAN Phase 16.1) — superadmin-only, feature-flagged,
// strictly rate-limited, optionally IP-allowlisted, and every mutation must
// carry a typed `reason` (audited). role:"admin" callers get 403 like anyone
// else — requireRole("superadmin") is the gate.

const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { requireAuth, requireRole } = require("../middleware/auth");
const { createLimiter } = require("../middleware/rateLimit");
const {
  listTenants,
  getTenant,
  suspendTenant,
  reactivateTenant,
  setTenantVoiceMode,
  listAuditLogs,
  listEmailLogs,
  usageRollup,
  listDemoRequests,
  trustDashboard,
  listDemoInterviews,
  createDemoInterview,
  reissueDemoInterview,
  revokeDemoInterview,
} = require("../controllers/platformController");

const router = express.Router();

// Rollback flag: PLATFORM_CONSOLE_ENABLED=false ⇒ every platform route 404s.
router.use((req, res, next) => {
  if (process.env.PLATFORM_CONSOLE_ENABLED === "false") {
    return res.status(404).json({ error: "Not found" });
  }
  next();
});

// Optional IP allowlist — when set, platform routes only answer these IPs.
router.use((req, res, next) => {
  const allow = (process.env.PLATFORM_IP_ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.length && !allow.includes(req.ip)) {
    return res.status(403).json({ error: "This address is not allowed to access the platform console" });
  }
  next();
});

const platformLimiter = createLimiter({ windowMs: 60 * 1000, max: 60, prefix: "rl:platform:" });
router.use(platformLimiter, requireAuth, requireRole("superadmin"));

// Mandatory typed reason on EVERY mutation — it lands in the audit row, and the
// AuditLog viewer below makes the console self-auditing.
function requireReason(req, res, next) {
  const reason = req.body?.reason;
  if (typeof reason !== "string" || reason.trim().length < 4) {
    return res.status(400).json({ error: "A reason (at least 4 characters) is required for every platform mutation" });
  }
  req.body.reason = reason.trim().slice(0, 500);
  next();
}

router.get("/tenants", listTenants);
router.get("/tenants/:id", getTenant);
router.post("/tenants/:id/suspend", requireReason, suspendTenant);
router.post("/tenants/:id/reactivate", requireReason, reactivateTenant);
router.post("/tenants/:id/voice-mode", requireReason, setTenantVoiceMode);

router.get("/audit-logs", listAuditLogs);
router.get("/email-logs", listEmailLogs);
router.get("/usage", usageRollup);
router.get("/demo-requests", listDemoRequests);
router.get("/trust", trustDashboard);

router.get("/demo-interviews", listDemoInterviews);
router.post("/demo-interviews", requireReason, createDemoInterview);
router.post("/demo-interviews/:id/reissue", requireReason, reissueDemoInterview);
router.post("/demo-interviews/:id/revoke", requireReason, revokeDemoInterview);

module.exports = wrapRouter(router);
// Exported for unit tests: the mandatory-reason guard is a Phase 16 guardrail.
module.exports.requireReason = requireReason;
