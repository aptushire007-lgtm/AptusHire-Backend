const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { requireAuth, requireRole } = require("../middleware/auth");
const { listCompanyAuditLogs } = require("../controllers/auditLogController");

const router = express.Router();

// Read-only by design: the audit trail is immutable-by-convention, so this
// router exposes no mutation route at all.
router.get("/", requireAuth, requireRole("admin"), listCompanyAuditLogs);

module.exports = wrapRouter(router);
