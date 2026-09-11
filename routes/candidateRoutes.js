const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const {
  listCandidates,
  relatedApplications,
  getCandidate,
  moveStage,
  getTimeline,
  exportCandidate,
  downloadResume,
  getAtsResult,
  getRejectionReport,
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

router.get("/", requireAdmin, listCandidates); // Phase 12.5 — company-wide, paginated (kills the per-job N+1); ?groupBy=candidate collapses multi-role applicants
router.get("/dashboard-summary", requireAdmin, require("../controllers/dashboardSummaryController").dashboardSummary);
router.get("/pipeline", requireAdmin, require("../controllers/pipelineReadController").pipelineRead);
router.get("/:id", requireAdmin, getCandidate);
router.get("/:id/related", requireAdmin, relatedApplications); // Phase 17 — other applications by the same person at this company
router.get("/:id/resume", requireAdmin, downloadResume);
router.get("/:id/timeline", requireAdmin, getTimeline);
router.get("/:id/export", requireAdmin, exportCandidate);
router.patch("/:id/status", requireAdmin, moveStage); // legacy body { status }
router.patch("/:id/stage", requireAdmin, moveStage); // preferred body { stage, note, offerMessage }
router.get("/:id/ats", requireAdmin, getAtsResult);
router.get("/:id/rejection-report", requireAdmin, getRejectionReport);
router.get("/:id/assessment", requireAdmin, getAssessment); // Phase 6 explainability ("why this score")
router.post("/:id/ats/rerun", requireAdmin, rerunAts);
router.get("/:id/interview-report", requireAdmin, getInterviewReport);
router.post("/:id/interview-review", requireAdmin, require("../controllers/interviewReviewController").recordInterviewReview);
router.get("/:id/interview-report/pdf", requireAdmin, getInterviewReportPdf);

module.exports = wrapRouter(router);
