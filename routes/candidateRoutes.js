const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const {
  listCandidates,
  getCandidate,
  moveStage,
  getTimeline,
  exportCandidate,
  downloadResume,
  getAtsResult,
  getAssessment,
  rerunAts,
  getInterviewReport,
  getInterviewReportPdf,
} = require("../controllers/candidateController");
const { requireAuth, requireRole, requireActiveCompany, requireActiveSubscription } = require("../middleware/auth");

const router = express.Router();
// requireActiveSubscription gates MUTATIONS only (Phase 11.2) — reads stay
// available to an expired tenant (read-only mode, never data lockout).
const requireAdmin = [requireAuth, requireRole("admin"), requireActiveCompany, requireActiveSubscription];

router.get("/", requireAdmin, listCandidates); // Phase 12.5 — company-wide, paginated (kills the per-job N+1)
router.get("/:id", requireAdmin, getCandidate);
router.get("/:id/resume", requireAdmin, downloadResume);
router.get("/:id/timeline", requireAdmin, getTimeline);
router.get("/:id/export", requireAdmin, exportCandidate);
router.patch("/:id/status", requireAdmin, moveStage); // legacy body { status }
router.patch("/:id/stage", requireAdmin, moveStage); // preferred body { stage, note, offerMessage }
router.get("/:id/ats", requireAdmin, getAtsResult);
router.get("/:id/assessment", requireAdmin, getAssessment); // Phase 6 explainability ("why this score")
router.post("/:id/ats/rerun", requireAdmin, rerunAts);
router.get("/:id/interview-report", requireAdmin, getInterviewReport);
router.get("/:id/interview-report/pdf", requireAdmin, getInterviewReportPdf);

module.exports = wrapRouter(router);
