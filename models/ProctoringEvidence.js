// ProctoringEvidence (BUILD-PLAN Phase 14.1) — one row per event-anchored
// evidence clip. This is the inversion of the proctoring-vendor posture:
// nothing is recorded continuously; a short clip is persisted ONLY when a
// high-severity proctoring event fires, consent-gated and hard-capped per
// session. Clips are for HUMAN review only — no LLM ever sees a frame, and
// nothing here enters any scoring path.

const mongoose = require("mongoose");

const proctoringEvidenceSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    session: { type: mongoose.Schema.Types.ObjectId, ref: "InterviewSession", required: true },
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate", required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job" },

    // The proctoring event this clip evidences (utils/proctoring.js taxonomy).
    eventType: { type: String, required: true, trim: true },
    source: { type: String, enum: ["laptop", "phone"], default: "laptop" },

    // The measurement that caused this capture: the rule that fired, the detector's own confidence,
    // how much of the frame the face filled, whether it was edge-cropped. Stored so a reviewer sees
    // the CLAIM and the FOOTAGE side by side — the point being that a clip which contradicts its own
    // label becomes obvious at a glance rather than quietly counting against someone. Server-
    // sanitized (evidenceClipService.sanitizeTrigger); nothing free-form from the browser lands here.
    trigger: { type: mongoose.Schema.Types.Mixed },
    // False for recording-condition events (detector_uncertain): this clip documents OUR view
    // quality, not the candidate's conduct, and no risk score counts it.
    scored: { type: Boolean, default: true },

    // Storage key under evidence/<companyId>/… (storageService).
    clipKey: { type: String, required: true },
    mimeType: { type: String, trim: true },
    sizeBytes: { type: Number },
    durationMs: { type: Number },
    // Server-computed hash of the uploaded bytes — lets a reviewer prove the
    // clip they watched is the clip that was captured.
    sha256: { type: String, trim: true },

    capturedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

proctoringEvidenceSchema.index({ company: 1, session: 1, createdAt: -1 });
proctoringEvidenceSchema.index({ company: 1, candidate: 1 });

proctoringEvidenceSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("ProctoringEvidence", proctoringEvidenceSchema);
