// AssessmentSession (ASSESSMENT-ENGINE-PLAN A2.1) — one candidate's run of a
// frozen AssessmentPaper. A SIBLING of InterviewSession, not a modification of
// it: the deviceCheck / speedTest / proctoring subdocuments are deliberate
// schema copies (refactoring a live model is riskier than two schema files).
//
// Invariants that matter:
//   - No session exists without an `assignment` naming the recruiter (or the
//     drive's auto mode) — the recruiter gate is structural, not advisory.
//   - `tokenHash` is unique; `candidate` is NOT (unlike InterviewSession) — a
//     candidate legitimately holds both an assessment and an interview session.
//   - The paper ref is version-pinned: regeneration after freeze never touches
//     an in-flight session.
//   - `result` is computed server-side by the pure scorer only; the candidate
//     API can never write it.

const mongoose = require("mongoose");

// --- copies of InterviewSession's check/proctoring shapes (see header) -------

const deviceCheckSchema = new mongoose.Schema(
  {
    camera: { type: Boolean, default: false },
    microphone: { type: Boolean, default: false },
    screenShare: { type: Boolean, default: false },
    fullscreen: { type: Boolean, default: false },
    deviceCompatible: { type: Boolean, default: false },
    browserInfo: { type: String, trim: true },
    completedAt: { type: Date },
  },
  { _id: false }
);

const speedTestSchema = new mongoose.Schema(
  {
    downloadMbps: { type: Number },
    testedAt: { type: Date },
  },
  { _id: false }
);

const proctoringEventSchema = new mongoose.Schema(
  {
    type: { type: String, required: true },
    severity: { type: String, enum: ["low", "medium", "high"], default: "low" },
    meta: { type: mongoose.Schema.Types.Mixed },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const proctoringSchema = new mongoose.Schema(
  {
    consent: {
      given: { type: Boolean, default: false },
      declined: { type: Boolean, default: false },
      at: { type: Date },
    },
    evidenceConsent: {
      given: { type: Boolean, default: false },
      declined: { type: Boolean, default: false },
      at: { type: Date },
      wordingVersion: { type: String, trim: true },
    },
    phoneCam: {
      paired: { type: Boolean, default: false },
      pairedAt: { type: Date },
      lastHeartbeatAt: { type: Date },
      lostFlagged: { type: Boolean, default: false },
    },
    visionEnabled: { type: Boolean, default: false },
    riskScore: { type: Number, default: 0 },
    riskBand: { type: String, enum: ["low", "medium", "high"], default: "low" },
    counts: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    totalEvents: { type: Number, default: 0 },
    identityMatch: {
      status: { type: String, enum: ["unknown", "match", "mismatch"], default: "unknown" },
      distance: { type: Number },
      checkedAt: { type: Date },
    },
    events: { type: [proctoringEventSchema], default: () => [] },
    lastEventAt: { type: Date },
  },
  { _id: false }
);

// --- assessment-specific shapes ----------------------------------------------

const assembledItemSchema = new mongoose.Schema(
  {
    itemId: { type: String, required: true },
    sectionId: { type: String, required: true },
    order: { type: Number, required: true },
    // Per-candidate option display order (seeded shuffle) — option ids.
    optionOrder: { type: [String], default: [] },
    // When A3.1 targeting placed this item to probe a specific unverified claim.
    targetsClaimId: { type: String },
  },
  { _id: false }
);

const responseSchema = new mongoose.Schema(
  {
    itemId: { type: String, required: true },
    // mcq: [optionIds] · numeric: Number · ordering: [optionIds in chosen order]
    response: { type: mongoose.Schema.Types.Mixed },
    timeSpentMs: { type: Number, default: 0 },
    markedForReview: { type: Boolean, default: false },
    savedAt: { type: Date },
  },
  { _id: false }
);

const sectionStateSchema = new mongoose.Schema(
  {
    sectionId: { type: String, required: true },
    status: { type: String, enum: ["not_started", "in_progress", "completed"], default: "not_started" },
    startedAt: { type: Date },
    completedAt: { type: Date },
    timeSpentMs: { type: Number, default: 0 },
  },
  { _id: false }
);

const claimVerdictSchema = new mongoose.Schema(
  {
    claimId: { type: String, required: true },
    criterionId: { type: String, default: "" },
    verdict: { type: String, enum: ["verified", "contradicted", "inconclusive"], required: true },
    itemIds: { type: [String], default: [] },
    correctCount: { type: Number, default: 0 },
    itemCount: { type: Number, default: 0 },
  },
  { _id: false }
);

const resultSchema = new mongoose.Schema(
  {
    scoredAt: { type: Date },
    scorerVersion: { type: String },
    reproducibilityHash: { type: String },
    totalItems: { type: Number },
    totalCorrect: { type: Number },
    perItem: {
      type: [new mongoose.Schema({ itemId: String, correct: Boolean, answered: Boolean }, { _id: false })],
      default: [],
    },
    perCriterion: {
      type: [
        new mongoose.Schema(
          { criterionId: String, itemCount: Number, correctCount: Number },
          { _id: false }
        ),
      ],
      default: [],
    },
    claimVerdicts: { type: [claimVerdictSchema], default: [] },
    // "submit" = candidate submitted · "expiry" = window closed, partial work scored (labelled, §A2
    // guardrails) · "integrity_violation" = auto-submitted after repeated hard proctoring signals
    // crossed the paper's configured threshold (see softLock.action below) — partial work scored the
    // same way, flagged distinctly so a recruiter never reads it as an ordinary submission.
    completedBy: { type: String, enum: ["submit", "expiry", "integrity_violation"] },
  },
  { _id: false }
);

const assessmentSessionSchema = new mongoose.Schema(
  {
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate", required: true, index: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    paper: { type: mongoose.Schema.Types.ObjectId, ref: "AssessmentPaper", required: true },
    paperVersion: { type: Number, required: true },

    // The recruiter gate (§3 rule 8): required — no session exists unassigned.
    assignment: {
      assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      assignedByName: { type: String, trim: true },
      at: { type: Date, required: true },
      mode: { type: String, enum: ["manual", "auto"], required: true },
    },

    // A3.0 — the difficulty tier this candidate was served, with its provenance.
    // Rendered on every report; cross-candidate views badge it.
    difficultyTier: {
      value: { type: String, enum: ["easy", "medium", "hard"] },
      source: { type: String, enum: ["claim_derived", "recruiter_override", "paper_fixed"] },
      basis: { type: String, default: "" },
    },

    tokenHash: { type: String, required: true, unique: true, index: true },
    validFrom: { type: Date, required: true },
    startDeadline: { type: Date, required: true },
    expiresAt: { type: Date, required: true },

    status: {
      type: String,
      enum: ["scheduled", "in_progress", "paused", "completed", "expired", "cancelled"],
      default: "scheduled",
    },
    accessedAt: { type: Date },
    startedAt: { type: Date },
    completedAt: { type: Date },

    // A4.2 soft-lock state. Pause only — termination is always a human action.
    pause: {
      pausedAt: { type: Date },
      reason: { type: String },
      pausedMsTotal: { type: Number, default: 0 }, // excluded from server-side elapsed time
      notifiedAdminAt: { type: Date },
    },
    softLock: {
      enabled: { type: Boolean, default: false },
      flagThreshold: { type: Number, default: 3 },
      // "pause" (default) or "auto_submit" — copied from the paper at session creation, see
      // assessmentService's session-seeding step and maybeSoftLock's branch on this field.
      action: { type: String, enum: ["pause", "auto_submit"], default: "pause" },
      triggeredCount: { type: Number, default: 0 },
    },

    assembledItems: { type: [assembledItemSchema], default: [] },
    responses: { type: [responseSchema], default: [] },
    sectionState: { type: [sectionStateSchema], default: [] },

    deviceCheck: { type: deviceCheckSchema, default: () => ({}) },
    speedTest: { type: speedTestSchema, default: () => ({}) },
    proctoring: { type: proctoringSchema, default: () => ({}) },

    result: { type: resultSchema, default: () => ({}) },

    reminder24hSent: { type: Boolean, default: false },
    reminder1hSent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// One LIVE session per candidate+job: partial unique index (completed/expired/
// cancelled sessions don't block a recruiter re-sending later).
assessmentSessionSchema.index(
  { candidate: 1, job: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["scheduled", "in_progress", "paused"] } } }
);
// Reminder cron scan (jobs/assessmentReminderJob).
assessmentSessionSchema.index({ status: 1, startDeadline: 1 });
assessmentSessionSchema.index({ company: 1, job: 1, status: 1 });

assessmentSessionSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("AssessmentSession", assessmentSessionSchema);
