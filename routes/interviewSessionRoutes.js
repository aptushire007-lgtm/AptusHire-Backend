const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const {
  verifyToken,
  getForCandidate,
  resendInterview,
  rescheduleInterview,
  listEvidence,
  streamEvidenceClip,
  streamTurnAudio,
  getRecordingUrl,
  listRecordings,
} = require("../controllers/interviewSessionController");
const { requireAuth, requireRole, requireActiveCompany } = require("../middleware/auth");

const router = express.Router();
const requireAdmin = [requireAuth, requireRole("admin"), requireActiveCompany];

router.get("/verify/:token", verifyToken);
router.get("/candidate/:id", requireAdmin, getForCandidate);
router.post("/candidate/:id/resend", requireAdmin, resendInterview);
router.post("/candidate/:id/reschedule", requireAdmin, rescheduleInterview);
// Phase 14.5 — evidence-clip review; every clip view writes an AuditLog row.
router.get("/candidate/:id/evidence", requireAdmin, listEvidence);
router.get("/evidence/:evidenceId", requireAdmin, streamEvidenceClip);
// Recorded answer audio — same audit-logged posture as evidence clips.
router.get("/candidate/:id/turn-audio/:turnIndex", requireAdmin, streamTurnAudio);
// Candidate video recording (Phase 7, default-off) — a Cloudinary secure URL, not a byte stream.
router.get("/candidate/:id/recording", requireAdmin, getRecordingUrl);
// Browse-all view for the admin "Recordings" page — every session with a recording attempt.
router.get("/recordings", requireAdmin, listRecordings);

module.exports = wrapRouter(router);
