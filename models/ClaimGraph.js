// ClaimGraph (BUILD-PLAN Phase 5.1) — the evidence-bound decomposition of one
// résumé: atomic claims, each independently cited into the canonical resume
// text, individually confidence-scored, and individually testable in an
// interview.
//
// Design decisions that ARE the product:
//   - Every claim carries ≥ 1 span VERIFIED in code as a literal substring of
//     the canonical text (utils/spanVerifier). A claim that cannot be cited
//     never reaches this collection.
//   - There is deliberately NO rubric reference here. Extraction is
//     rubric-blind by construction (knowing what the job wants biases what the
//     model "reads"); the pairing of claims with a rubric happens in
//     AtsAssessment (Phase 6).
//   - timelineGaps are recorded and NEVER scored (documented disparate impact
//     on carers and people with health conditions). They may only ever become
//     a neutral interview probe with explicit tenant opt-in.

const mongoose = require("mongoose");

const CLAIM_TYPES = ["skill", "experience", "outcome", "education", "project", "certification", "employment_period"];
const SPECIFICITY = ["vague", "specific", "quantified"];
const VERIFICATION_STATUSES = [
  "unverified",
  "corroborated_internally",
  "contradicted_internally",
  // Assessment verdicts (ASSESSMENT-ENGINE-PLAN A3.2) — additive. The evidence
  // hierarchy is: self-reported < corroborated < verified_in_assessment <
  // verified_in_interview (an MCQ is real proof, but weaker than a probed live
  // explanation). Interview verdicts therefore overwrite assessment verdicts,
  // never the reverse.
  "verified_in_assessment",
  "contradicted_in_assessment",
  "verified_in_interview",
  "contradicted_in_interview",
  // Human-round verdicts (RoundScorecard). Top of the hierarchy: a person who
  // probed the claim live and cited what they heard is the strongest evidence
  // the system holds, so these overwrite machine verdicts and are never
  // overwritten by them (precedence is enforced in utils/scorecardEngine
  // `outranks`, the single place the ordering is declared).
  "verified_by_human",
  "contradicted_by_human",
];

const spanSchema = new mongoose.Schema(
  {
    start: { type: Number, required: true, min: 0 },
    end: { type: Number, required: true, min: 0 },
    quote: { type: String, required: true },
  },
  { _id: false }
);

const claimSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    type: { type: String, enum: CLAIM_TYPES, required: true },
    subject: { type: String, required: true, trim: true },
    predicate: { type: String, trim: true, default: "" },
    object: { type: String, trim: true, default: "" },
    normalized: {
      skill: { type: String, trim: true },      // canonical ontology id where known
      rawSkill: { type: String, trim: true },   // the surface form, for ontology growth
      years: { type: Number },
      level: { type: String, trim: true },
      domain: { type: String, trim: true },
      startDate: { type: String, trim: true },  // as stated, ISO-ish "2022-01" — parsed in code
      endDate: { type: String, trim: true },
    },
    spans: {
      type: [spanSchema],
      required: true,
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "a claim without a verified span cannot exist (cite-or-drop)",
      },
    },
    confidence: { type: Number, min: 0, max: 1, default: 0.5 }, // extraction confidence, never a hiring score
    specificity: { type: String, enum: SPECIFICITY, default: "vague" },
    verificationStatus: { type: String, enum: VERIFICATION_STATUSES, default: "unverified" },
    selfReportedOnly: { type: Boolean, default: true },
  },
  { _id: false }
);

const claimGraphSchema = new mongoose.Schema(
  {
    candidate: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate", required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    resumeHash: { type: String, required: true },

    claims: { type: [claimSchema], default: [] },

    internalContradictions: {
      type: [
        new mongoose.Schema(
          {
            claimIds: { type: [String], default: [] },
            description: { type: String, required: true },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    // Recorded, NEVER scored. See header.
    timelineGaps: {
      type: [
        new mongoose.Schema(
          {
            from: { type: String },
            to: { type: String },
            months: { type: Number },
          },
          { _id: false }
        ),
      ],
      default: [],
    },

    extraction: {
      engine: { type: String, enum: ["ai", "none"], required: true },
      model: { type: String },
      promptVersion: { type: String },
      ontologyVersion: { type: String },
      redactorVersion: { type: String },
      samples: { type: Number, default: 1 },
      agreement: { type: Number },
      at: { type: Date, required: true },
      // Hallucination kill-switch telemetry: how many model claims/spans were
      // dropped because their quote was not a literal substring.
      droppedClaims: { type: Number, default: 0 },
      droppedSpans: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

claimGraphSchema.index({ candidate: 1, resumeHash: 1 });
claimGraphSchema.index({ company: 1, job: 1, createdAt: -1 });

claimGraphSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("ClaimGraph", claimGraphSchema);
module.exports.CLAIM_TYPES = CLAIM_TYPES;
module.exports.SPECIFICITY = SPECIFICITY;
module.exports.VERIFICATION_STATUSES = VERIFICATION_STATUSES;
