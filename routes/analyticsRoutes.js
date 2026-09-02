const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { getOverview, getEvidence, getAuditPack, getSources } = require("../controllers/analyticsController");
const { requireAuth, requireRole, requireActiveCompany } = require("../middleware/auth");

const router = express.Router();
const requireAdmin = [requireAuth, requireRole("admin"), requireActiveCompany];

router.get("/overview", requireAdmin, getOverview);
router.get("/evidence", requireAdmin, getEvidence);
router.get("/audit-pack", requireAdmin, getAuditPack);
router.get("/sources", requireAdmin, getSources); // Phase 15.9 — source quality by downstream truth

module.exports = wrapRouter(router);
