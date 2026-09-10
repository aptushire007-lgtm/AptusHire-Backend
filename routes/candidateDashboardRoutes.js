const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const {
  getDashboard,
  getDashboardSummary,
  updateProfile,
  getOwnApplication,
  getOwnAssessmentResult,
  getOwnRejectionReport,
  toggleSavedJob,
  openOwnSession,
  resendOwnSessionLink,
} = require("../controllers/candidateDashboardController");
const {
  listResumeVersions,
  uploadResumeVersion,
  updateResumeVersion,
  setDefaultResumeVersion,
  archiveResumeVersion,
  deleteResumeVersion,
  getMatchScoresForJob,
} = require("../controllers/resumeVersionController");
const {
  getFullProfile,
  updatePersonalInfo,
  sendOtp,
  verifyOtp,
  updateEducation,
  updateExperience,
  updatePreferences,
  uploadGovDocument,
  exportCandidateData,
} = require("../controllers/candidateProfileFullController");
const resumeUpload = require("../middleware/resumeUpload");
const { requireAuth, requireRole } = require("../middleware/auth");
const { createLimiter } = require("../middleware/rateLimit");

const router = express.Router();
const requireCandidate = [requireAuth, requireRole("candidate")];

const resendLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  prefix: "rl:cand-resend:",
  keyGenerator: (req) => String(req.user?._id || req.ip),
  message: "You've requested a few links already — please check your inbox and spam folder, then try again later.",
});

const otpSendLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  prefix: "rl:cand-otp-send:",
  keyGenerator: (req) => String(req.user?._id || req.ip),
  message: "Too many verification code requests — please try again later.",
});

const otpVerifyLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  prefix: "rl:cand-otp-verify:",
  keyGenerator: (req) => String(req.user?._id || req.ip),
  message: "Too many verification attempts — please try again later.",
});

const openLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 60,
  prefix: "rl:cand-open:",
  keyGenerator: (req) => String(req.user?._id || req.ip),
  message: "Too many attempts to open this session — please wait a moment and try again.",
});

// ---- Core Dashboard ----
router.get("/", requireCandidate, getDashboard);
router.get("/summary", requireCandidate, getDashboardSummary);
router.patch("/profile", requireCandidate, updateProfile);
router.get("/applications/:id", requireCandidate, getOwnApplication);
router.get("/assessments/:id/result", requireCandidate, getOwnAssessmentResult);
router.get("/applications/:id/rejection-report", requireCandidate, getOwnRejectionReport);
router.post("/saved-jobs/:jobId", requireCandidate, toggleSavedJob);
router.post("/sessions/:kind/:id/open", requireCandidate, openLimiter, openOwnSession);
router.post("/sessions/:kind/:id/resend", requireCandidate, resendLimiter, resendOwnSessionLink);

// ---- Resume Version Manager (★ Core Differentiator) ----
router.get("/resumes", requireCandidate, listResumeVersions);
router.post("/resumes/upload", requireCandidate, resumeUpload.single("resume"), uploadResumeVersion);
router.patch("/resumes/:id", requireCandidate, updateResumeVersion);
router.patch("/resumes/:id/default", requireCandidate, setDefaultResumeVersion);
router.patch("/resumes/:id/archive", requireCandidate, archiveResumeVersion);
router.delete("/resumes/:id", requireCandidate, deleteResumeVersion);
router.get("/jobs/:jobId/match-versions", requireCandidate, getMatchScoresForJob);

// ---- 6-Tab Profile & Trust Verification Engine ----
router.get("/profile/full", requireCandidate, getFullProfile);
router.put("/profile/personal", requireCandidate, updatePersonalInfo);
router.post("/profile/otp/send", requireCandidate, otpSendLimiter, sendOtp);
router.post("/profile/otp/verify", requireCandidate, otpVerifyLimiter, verifyOtp);
router.put("/profile/education", requireCandidate, updateEducation);
router.put("/profile/experience", requireCandidate, updateExperience);
router.put("/profile/preferences", requireCandidate, updatePreferences);
router.post("/profile/documents/upload", requireCandidate, resumeUpload.single("document"), uploadGovDocument);
router.get("/profile/export-data", requireCandidate, exportCandidateData);

module.exports = wrapRouter(router);
