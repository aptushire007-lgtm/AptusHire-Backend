const AuditLog = require("../models/AuditLog");
const tenantContext = require("../utils/tenantContext");

// Paths we never want in the audit trail (health/readiness probes fire constantly and
// carry no security signal). Matched by prefix against req.path.
const IGNORED_PREFIXES = ["/api/health", "/api/ready", "/metrics"];
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function truncate(str, max) {
  if (typeof str !== "string") return str;
  return str.length > max ? str.slice(0, max) : str;
}

// Fire-and-forget write. Must NEVER throw into the request path or reject a request —
// a failed audit write is logged and swallowed. Runs outside any tenant context so the
// tenantScope plugin can't interfere (AuditLog isn't tenant-scoped anyway).
function persist(entry) {
  tenantContext.runAsSystem(() => {
    AuditLog.create(entry).catch((err) => {
      console.error("[audit] failed to write audit log:", err.message);
    });
  });
}

// Explicit audit for a specific security event (erasure, export, refresh-token reuse,
// auth). Callable from controllers even for anonymous flows (no req.user). Never awaited.
function writeAuditLog({ req, action, company, resourceType, resourceId, statusCode, meta }) {
  try {
    const user = req?.user;
    persist({
      company: company || user?.company || undefined,
      actorUserId: user?._id,
      actorRole: user?.role,
      actorEmail: user?.email,
      action,
      method: req?.method,
      path: req ? truncate(req.originalUrl || req.url, 512) : undefined,
      resourceType,
      resourceId: resourceId != null ? String(resourceId) : undefined,
      statusCode,
      ip: req?.ip,
      userAgent: truncate(req?.headers?.["user-agent"], 512),
      meta,
    });
  } catch (err) {
    console.error("[audit] writeAuditLog error:", err.message);
  }
}

// Middleware: records every AUTHENTICATED mutating request once the response finishes.
// Anonymous and read (GET/HEAD/OPTIONS) traffic is skipped here — important anonymous
// security events (login, register) are logged explicitly via writeAuditLog in their
// controllers. Controllers may set `req.audit = { action, resourceType, resourceId, meta }`
// to enrich the entry.
function auditLog(req, res, next) {
  if (READ_METHODS.has(req.method)) return next();
  if (IGNORED_PREFIXES.some((p) => req.path.startsWith(p))) return next();

  res.on("finish", () => {
    // req.user is populated by requireAuth during the handler; still attached at finish.
    if (!req.user) return; // anonymous mutations are logged explicitly where they matter
    const extra = req.audit || {};
    writeAuditLog({
      req,
      action: extra.action || `${req.method} ${truncate(req.path, 256)}`,
      resourceType: extra.resourceType,
      resourceId: extra.resourceId,
      statusCode: res.statusCode,
      meta: extra.meta,
    });
  });

  next();
}

module.exports = { auditLog, writeAuditLog };
