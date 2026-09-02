const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { listQueue, resolveItem } = require("../controllers/reviewQueueController");
const { requireAuth, requireRole, requireActiveCompany } = require("../middleware/auth");

const router = express.Router();
const requireAdmin = [requireAuth, requireRole("admin"), requireActiveCompany];

router.get("/", requireAdmin, listQueue);
// Resolution sets req.audit; the global auditLog middleware persists it.
router.post("/:id/resolve", requireAdmin, resolveItem);

module.exports = wrapRouter(router);
