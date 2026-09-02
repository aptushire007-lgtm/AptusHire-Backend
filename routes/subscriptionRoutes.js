const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { listPlans, getCompanySubscription, getUsage } = require("../controllers/subscriptionController");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

router.get("/plans", listPlans);
router.get("/me", requireAuth, requireRole("admin"), getCompanySubscription);
router.get("/usage", requireAuth, requireRole("admin"), getUsage); // Phase 11.3 — approaching-limit warnings

module.exports = wrapRouter(router);
