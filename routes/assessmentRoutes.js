// Admin assessment routes (papers + sessions + the recruiter gate). The whole
// router is mounted behind the ASSESSMENT_ENGINE_ENABLED env flag in server.js
// (gate 1 of 4) — with the flag off, none of these paths exist.

const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const {
  compileForJob,
  getForJob,
  getPaper,
  updatePaper,
  generateItems,
  regenerateItem,
  retireItem,
  approvePaper,
} = require("../controllers/assessmentPaperController");
const {
  sendToCandidate,
  skipForCandidate,
  getForCandidate,
  jobOverview,
  decisionAudit,
  resend,
  cancel,
  resumeSession,
  endSession,
} = require("../controllers/assessmentController");
const { requireAuth, requireRole, requireActiveCompany } = require("../middleware/auth");

const router = express.Router();
const requireAdmin = [requireAuth, requireRole("admin"), requireActiveCompany];

// Papers (A1)
router.post("/papers/job/:jobId/compile", requireAdmin, compileForJob);
router.get("/papers/job/:jobId", requireAdmin, getForJob);
router.get("/papers/:id", requireAdmin, getPaper);
router.patch("/papers/:id", requireAdmin, updatePaper);
router.post("/papers/:id/items/generate", requireAdmin, generateItems);
router.post("/papers/:id/items/:itemId/regenerate", requireAdmin, regenerateItem);
router.post("/papers/:id/items/:itemId/retire", requireAdmin, retireItem);
router.post("/papers/:id/approve", requireAdmin, approvePaper);

// The recruiter gate + tracker (A2)
router.get("/job/:jobId/overview", requireAdmin, jobOverview);
router.get("/job/:jobId/decision-audit", requireAdmin, decisionAudit);
router.post("/candidate/:candidateId/send", requireAdmin, sendToCandidate);
router.post("/candidate/:candidateId/skip", requireAdmin, skipForCandidate);
router.get("/candidate/:candidateId", requireAdmin, getForCandidate);

// Session actions (resend/cancel + A4.2 soft-lock human actions)
router.post("/sessions/:id/resend", requireAdmin, resend);
router.post("/sessions/:id/cancel", requireAdmin, cancel);
router.post("/sessions/:id/resume", requireAdmin, resumeSession);
router.post("/sessions/:id/end", requireAdmin, endSession);

module.exports = wrapRouter(router);
