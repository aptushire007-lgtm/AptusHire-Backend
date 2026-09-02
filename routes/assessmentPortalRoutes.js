// Candidate assessment portal routes (A2.4/A2.5). Magic-link login → JWT with
// aud "assessment"; every authed route re-checks session state + expiry through
// requireAssessmentAuth. Answer saves are rate-limited per candidate.

const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const {
  login,
  me,
  submitChecks,
  start,
  startSection,
  saveResponse,
  submitSection,
  submit,
  proctoringConsent,
  proctoringEvents,
} = require("../controllers/assessmentPortalController");
const { requireAssessmentAuth } = require("../middleware/assessmentAuth");
const { createLimiter, portalKey } = require("../middleware/rateLimit");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

const loginLimiter = createLimiter({ windowMs: 60 * 1000, max: 20, prefix: "rl:assess-login:" });
// Autosave fires per answer + on palette moves; generous but bounded.
const saveLimiter = createLimiter({ windowMs: 60 * 1000, max: 120, prefix: "rl:assess-save:", keyGenerator: portalKey });
const proctoringLimiter = createLimiter({ windowMs: 60 * 1000, max: 60, prefix: "rl:assess-proctor:", keyGenerator: portalKey });

router.post("/login", loginLimiter, asyncHandler(login));
router.get("/me", requireAssessmentAuth, asyncHandler(me));
router.post("/checks", requireAssessmentAuth, asyncHandler(submitChecks));
router.post("/start", requireAssessmentAuth, asyncHandler(start));
router.post("/sections/:sectionId/start", requireAssessmentAuth, asyncHandler(startSection));
router.post("/responses", requireAssessmentAuth, saveLimiter, asyncHandler(saveResponse));
router.post("/sections/:sectionId/submit", requireAssessmentAuth, asyncHandler(submitSection));
router.post("/submit", requireAssessmentAuth, asyncHandler(submit));
router.post("/proctoring/consent", requireAssessmentAuth, proctoringLimiter, asyncHandler(proctoringConsent));
router.post("/proctoring/events", requireAssessmentAuth, proctoringLimiter, asyncHandler(proctoringEvents));

module.exports = wrapRouter(router);
