const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const {
  listQuestionSets,
  reviewQuestionSet,
  autoDraftQuestionSet,
  createQuestionSet,
  updateQuestionSet,
  approveQuestionSet,
} = require("../controllers/questionSetController");
const { requireAuth, requireRole, requireActiveCompany } = require("../middleware/auth");

// mergeParams so :jobId from the mount path reaches the handlers.
const router = express.Router({ mergeParams: true });
const requireAdmin = [requireAuth, requireRole("admin"), requireActiveCompany];

router.get("/", requireAdmin, listQuestionSets);
router.post("/review", requireAdmin, reviewQuestionSet);
router.post("/auto-draft", requireAdmin, autoDraftQuestionSet);
router.post("/", requireAdmin, createQuestionSet);
router.patch("/:id", requireAdmin, updateQuestionSet);
router.post("/:id/approve", requireAdmin, approveQuestionSet);

module.exports = wrapRouter(router);
