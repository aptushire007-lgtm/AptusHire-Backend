const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const {
  getSettings,
  updateSettings,
  getCareersInfo,
  listBoardCredentials,
  saveBoardCredential,
  deleteBoardCredential,
  testBoardCredential,
} = require("../controllers/companySettingsController");
const { requireAuth, requireRole, requireActiveCompany, requireActiveSubscription } = require("../middleware/auth");

const router = express.Router();
const requireAdmin = [requireAuth, requireRole("admin"), requireActiveCompany];
// Credential writes are mutations → also gated on an active subscription.
const requireAdminSub = [...requireAdmin, requireActiveSubscription];

router.get("/", requireAdmin, getSettings);
router.put("/", requireAdmin, updateSettings);

// Phase 15 — distribution surface.
router.get("/careers-info", requireAdmin, getCareersInfo);
router.get("/board-credentials", requireAdmin, listBoardCredentials);
router.put("/board-credentials/:board", requireAdminSub, saveBoardCredential);
router.delete("/board-credentials/:board", requireAdminSub, deleteBoardCredential);
router.post("/board-credentials/:board/test", requireAdminSub, testBoardCredential);

module.exports = wrapRouter(router);
