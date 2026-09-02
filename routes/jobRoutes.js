const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const {
  createJob,
  listJobs,
  listPublishedJobs,
  getJob,
  updateJob,
  publishJob,
  deleteJob,
  listPublications,
  publishBoards,
  withdrawBoard,
} = require("../controllers/jobController");
const { applyToJob, autofillFromResume, listCandidatesForJob } = require("../controllers/candidateController");
const upload = require("../middleware/upload");
const { createLimiter } = require("../middleware/rateLimit");
const { requireAuth, optionalAuth, requireRole, requireActiveCompany, requireActiveSubscription } = require("../middleware/auth");

const router = express.Router();
// requireActiveSubscription gates MUTATIONS only (Phase 11.2) — reads stay
// available to an expired tenant (read-only mode, never data lockout).
const requireAdmin = [requireAuth, requireRole("admin"), requireActiveCompany, requireActiveSubscription];
const requireCandidate = [requireAuth, requireRole("candidate")];

router.get("/published", listPublishedJobs);
router.post("/", requireAdmin, createJob);
router.get("/", requireAdmin, listJobs);
router.get("/:id", optionalAuth, getJob);
router.put("/:id", requireAdmin, updateJob);
router.patch("/:id/publish", requireAdmin, publishJob);
router.delete("/:id", requireAdmin, deleteJob);

// Apply is the most expensive public-facing endpoint (storage write + pdf-parse
// + in live mode several LLM calls) — bounded per account so one login can't
// drive unbounded tenant spend. Sits after auth so the key is the user id.
const applyLimiter = createLimiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  prefix: "rl:apply:",
  keyGenerator: (req) => String(req.user?._id || req.ip),
  message: "Too many applications in a short time — please wait a few minutes and try again.",
});
router.post("/:id/apply", requireCandidate, applyLimiter, upload.single("resume"), applyToJob);

// Autofill is an LLM call over a file the CALLER controls, so it is the easiest
// cost-amplification target on the candidate side: upload, parse, abandon,
// repeat. Bounded per account and set well above honest use (re-reading a form,
// swapping résumé versions, applying to several roles in one sitting) — the
// per-résumé cache means a candidate doing any of those normally spends one
// call, not one per attempt.
const autofillLimiter = createLimiter({
  windowMs: 60 * 60 * 1000,
  max: 20,
  prefix: "rl:autofill:",
  keyGenerator: (req) => String(req.user?._id || req.ip),
  message: "Too many autofill requests — please wait a little and try again, or fill the form in manually.",
});
router.post("/:id/apply/autofill", requireCandidate, autofillLimiter, autofillFromResume);

router.get("/:id/candidates", requireAdmin, listCandidatesForJob);

// Phase 15 — multi-board publishing (mutations gated on an active subscription).
router.get("/:id/publications", requireAuth, requireRole("admin"), requireActiveCompany, listPublications);
router.post("/:id/publish-boards", requireAdmin, publishBoards);
router.post("/:id/withdraw-board", requireAdmin, withdrawBoard);

module.exports = wrapRouter(router);
