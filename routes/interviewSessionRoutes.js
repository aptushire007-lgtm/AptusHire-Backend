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
// Playback URLs for the latest candidate attempt or an exact session, authorized identically.
router.get("/candidate/:id/recording", requireAdmin, getRecordingUrl);
router.get("/recordings/:sessionId", requireAdmin, getRecordingUrl);
// Browse-all view for the admin "Recordings" page — every session with a recording attempt.
router.get("/recordings", requireAdmin, listRecordings);

module.exports = wrapRouter(router);
