const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const {
  uploadResume,
  getResume,
  downloadResume,
  listResumeHistory,
  deleteResume,
} = require("../controllers/resumeController");
const resumeUpload = require("../middleware/resumeUpload");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// The resume library is the candidate-facing "My Resumes" feature. Every route
// is scoped to the authenticated candidate's own email inside the controller —
// resumes contain PII (name, phone, work history, full extracted text), so the
// account identity, never a client-supplied email/id, is the authorization key.
const requireCandidate = [requireAuth, requireRole("candidate")];

router.post("/", requireCandidate, resumeUpload.single("resume"), uploadResume);
router.get("/history", requireCandidate, listResumeHistory);
router.get("/:id", requireCandidate, getResume);
router.get("/:id/download", requireCandidate, downloadResume);
// Removing a résumé from the library. Owner-scoped in the controller like every other route here;
// deletes the stored object as well as the row, because "delete" that leaves the file in an object
// store is not a delete a candidate would recognise as one.
router.delete("/:id", requireCandidate, deleteResume);

module.exports = wrapRouter(router);
