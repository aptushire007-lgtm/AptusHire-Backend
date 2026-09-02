// RoundScorecard — one interviewer's evidence-bound record of one human round
// (hr_interview / technical_interview / manager_interview).
//
// Why this exists: the pipeline already runs three human rounds
// (utils/pipeline.js ROUND_STAGES) and, until now, recorded NOTHING about them.
// Every machine judgement in this platform carries span-verified citations and a
// reproducibility hash; the human judgements — the ones that actually decide the
// hire — carried a stage transition and nothing else. That asymmetry is the first
// thing a Local Law 144 auditor finds.
//
// Design decisions that ARE the product:
//   - Rows come from the job's FROZEN RoleRubric, pinned by version here. There
//     is no global competency list. "Time Management: 2/5" for a role whose
//     rubric never asked for time management is an unjustifiable input, and it is
//     the row a plaintiff picks first.
//   - BLIND-FIRST. `engineSnapshot` is captured when the scorecard is OPENED and
//     is never serialized to the panelist until they submit (allow-list in
//     scorecardService, same discipline as an AssessmentPaper answer key). The
//     interviewer rates what they saw, then the delta is recorded. Rating after
//     reading the AI's score would launder the model's opinion into a "human
//     decision" — the exact laundering rule 1 exists to prevent, one layer up.
//   - The panelist needs no account. A magic link with `aud: "scorecard"` (see
//     middleware/scorecardAuth) mirrors the assessment portal exactly: a hiring
//     manager who logs in twice a year, or an external panelist who never will,
//     must not be the reason the round goes unrecorded.
//   - Submitted is IMMUTABLE and terminal — same law as RoleRubric and
//     AssessmentPaper. Evidence you can edit after the fact is not evidence. A
//     correction is a second scorecard, never a rewrite of the first.
//   - One scorecard PER INTERVIEWER per round, not one per round. Two panelists
//     who disagree are a routing signal (rule 4), so their observations are never
//     merged into one falsely-confident record.

const mongoose = require("mongoose");
const { ROUND_STAGES } = require("../utils/pipeline");
const { DECISIONS, CLAIM_VERDICTS, RATING_MIN, RATING_MAX } = require("../utils/scorecardEngine");

const claimVerdictSchema = new mongoose.Schema(
  {
    claimId: { type: String, required: true },
    verdict: { type: String, enum: CLAIM_VERDICTS, required: true },
    // Non-empty for verified/contradicted — enforced in scorecardEngine
    // (validateSubmission), which is where the cite-or-abstain rule lives.
    note: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const ratingRowSchema = new mongoose.Schema(
  {
    criterionId: { type: String, required: true },
    // null ⇔ notAssessed. The DEFAULT outcome: an interviewer who did not probe
    // something says so, rather than being forced to invent a 3.
    rating: { type: Number, min: RATING_MIN, max: RATING_MAX, default: null },
    notAssessed: { type: Boolean, default: true },
    note: { type: String, trim: true, default: "" },
    claimVerdicts: { type: [claimVerdictSchema], default: [] },
  },
  { _id: false }
);

// Computed by utils/scorecardEngine only. No API path writes this.
const rollupSchema = new mongoose.Schema(
  {
    score: { type: Number, default: null },       // null = withheld (see withheldReason)
    withheldReason: { type: String, default: "" },
    coverage: { type: Number, default: 0 },
    assessedCount: { type: Number, default: 0 },
    ratableCount: { type: Number, default: 0 },
    perCriterion: { type: [mongoose.Schema.Types.Mixed], default: [] },
    engineVersion: { type: String, trim: true },
    reproducibilityHash: { type: String, trim: true },
  },
  { _id: false }
);

const roundScorecardSchema = new mongoose.Schema(
  {
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate", required: true, index: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },

    stage: { type: String, enum: ROUND_STAGES, required: true },

    // Version-pinned: a rubric superseded mid-process never retro-changes the
    // form this interviewer actually filled in.
    rubric: { type: mongoose.Schema.Types.ObjectId, ref: "RoleRubric", required: true },
    rubricVersion: { type: Number, required: true },

    // `user` is optional BY DESIGN — external panelists have no account. Name and
    // email are required so every observation has a person attached to it.
    interviewer: {
      user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      name: { type: String, required: true, trim: true },
      email: { type: String, required: true, trim: true, lowercase: true },
    },
    invitedBy: {
      user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      name: { type: String, trim: true },
      at: { type: Date, required: true },
    },

    tokenHash: { type: String, required: true, unique: true, index: true },
    expiresAt: { type: Date, required: true },

    status: { type: String, enum: ["open", "submitted", "cancelled"], default: "open" },
    openedAt: { type: Date },

    // The probe list this round was handed: claims still unverified when the
    // scorecard was opened. Recorded so the report can show what this
    // interviewer was ASKED to test, not just what they answered.
    targetClaims: {
      type: [
        new mongoose.Schema(
          { claimId: String, criterionId: String, summary: String, probeHint: String },
          { _id: false }
        ),
      ],
      default: [],
    },

    ratings: { type: [ratingRowSchema], default: [] },
    rollup: { type: rollupSchema, default: () => ({}) },

    // Blind-first proof. Captured at OPEN, withheld from the panelist payload
    // until `status === "submitted"`.
    engineSnapshot: {
      score: { type: Number, default: null },
      band: { type: String, trim: true, default: "" },
      capturedAt: { type: Date },
    },
    revealedAt: { type: Date },
    disagreement: {
      engineScore: { type: Number, default: null },
      humanScore: { type: Number, default: null },
      delta: { type: Number, default: null },
      direction: { type: String, trim: true, default: "unavailable" },
    },

    decision: { type: String, enum: DECISIONS },
    decisionReason: { type: String, trim: true, default: "" },
    submittedAt: { type: Date },

    reminderSent: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// One OPEN scorecard per interviewer per candidate per round — re-inviting the
// same panelist must not mint a second live form.
roundScorecardSchema.index(
  { company: 1, candidate: 1, stage: 1, "interviewer.email": 1 },
  { unique: true, partialFilterExpression: { status: "open" } }
);
roundScorecardSchema.index({ company: 1, candidate: 1, stage: 1 });
roundScorecardSchema.index({ status: 1, expiresAt: 1 }); // reminder + expiry sweep

// --- Immutability -------------------------------------------------------------
// A submitted scorecard admits NOTHING. Not the ratings, not the decision, not
// the reason. Same law as RoleRubric/AssessmentPaper, and stricter than both,
// because there is no legitimate archive/retire motion on a personal
// observation: a correction is a second scorecard with its own author and
// timestamp, so the record shows that someone changed their mind — which is
// itself evidence — rather than quietly showing only the revised opinion.
//
// Pure checker, exported for unit tests.
function submittedViolation(wasSubmitted, modifiedPaths) {
  if (!wasSubmitted) return null;
  const disallowed = (modifiedPaths || []).filter((p) => p !== "updatedAt");
  if (disallowed.length) {
    return `RoundScorecard is submitted — cannot modify [${disallowed.join(", ")}]; submit a correcting scorecard instead`;
  }
  return null;
}

roundScorecardSchema.post("init", function () {
  this.$locals.wasSubmitted = this.status === "submitted";
});

roundScorecardSchema.pre("save", function () {
  const violation = submittedViolation(Boolean(this.$locals?.wasSubmitted), this.modifiedPaths());
  if (violation) throw new Error(violation);
});

// Query-level updates bypass document middleware — banned outright, same as the
// other frozen collections.
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne"]) {
  roundScorecardSchema.pre(op, function () {
    throw new Error(`RoundScorecard does not allow query-level ${op} — load the document and save via scorecardService`);
  });
}

roundScorecardSchema.plugin(require("./plugins/tenantScope"));

const RoundScorecard = mongoose.model("RoundScorecard", roundScorecardSchema);
RoundScorecard.submittedViolation = submittedViolation;
module.exports = RoundScorecard;
