const mongoose = require("mongoose");
const { STAGES, REJECTED } = require("../utils/pipeline");

// Where one submitted form field came from. Computed SERVER-SIDE at submit by
// diffing what the candidate sent against the suggestions we cached for their
// résumé — never asserted by the client, which could otherwise claim it typed
// everything itself and erase the distinction this record exists to preserve.
//
//   candidate         — typed by the person. Their own independent attestation.
//   autofill_accepted — machine-suggested from their résumé, accepted verbatim.
//                       This is the RÉSUMÉ RESTATED, not a second source: it may
//                       never be treated as independent corroboration of the
//                       span it came from.
//   autofill_edited   — machine-suggested, then changed. The edit is the
//                       candidate's own act; a change that contradicts the cited
//                       span is a divergence worth a probe, never an auto-penalty.
//
// `spans` index into the canonical résumé text (Candidate.resumeText), so any
// screen can show a recruiter the exact sentence a field came from.
const fieldSpanSchema = new mongoose.Schema(
  {
    start: { type: Number, required: true },
    end: { type: Number, required: true },
    quote: { type: String, required: true },
  },
  { _id: false }
);

const provenanceSchema = new mongoose.Schema(
  {
    source: {
      type: String,
      enum: ["candidate", "autofill_accepted", "autofill_edited"],
      default: "candidate",
    },
    spans: { type: [fieldSpanSchema], default: [] },
    promptVersion: { type: String, trim: true },
  },
  { _id: false }
);

const experienceSchema = new mongoose.Schema(
  {
    company: { type: String, required: true, trim: true },
    role: { type: String, required: true, trim: true },
    startDate: { type: String, trim: true },
    endDate: { type: String, trim: true },
    currentlyWorking: { type: Boolean, default: false },
    description: { type: String, trim: true },
    provenance: { type: provenanceSchema },
  },
  { _id: false }
);

const educationSchema = new mongoose.Schema(
  {
    institution: { type: String, required: true, trim: true },
    degree: { type: String, required: true, trim: true },
    fieldOfStudy: { type: String, trim: true },
    startYear: { type: String, trim: true },
    endYear: { type: String, trim: true },
    grade: { type: String, trim: true },
    provenance: { type: provenanceSchema },
  },
  { _id: false }
);

const projectSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    techStack: { type: String, trim: true },
    link: { type: String, trim: true },
    provenance: { type: provenanceSchema },
  },
  { _id: false }
);

const certificateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    issuer: { type: String, trim: true },
    issueDate: { type: String, trim: true },
    credentialUrl: { type: String, trim: true },
    provenance: { type: provenanceSchema },
  },
  { _id: false }
);

// `skills` stays a flat [String] (every consumer reads it that way), so its
// provenance rides alongside in a parallel array keyed by value rather than by
// index — indices shift when a candidate removes a skill, value does not.
const skillProvenanceSchema = new mongoose.Schema(
  {
    value: { type: String, required: true, trim: true },
    source: { type: String, enum: ["candidate", "autofill_accepted", "autofill_edited"], default: "candidate" },
    spans: { type: [fieldSpanSchema], default: [] },
  },
  { _id: false }
);

// Application-autofill record. Exists so that "did a machine write this
// candidate's application?" is a query, not an archaeology exercise — and so a
// bias audit can compare outcomes between candidates who used it and who did not.
const autofillRecordSchema = new mongoose.Schema(
  {
    used: { type: Boolean, default: false },
    version: { type: String, trim: true },
    promptVersion: { type: String, trim: true },
    engine: { type: String, enum: ["ai", "deterministic"] },
    // Counts across every section: how many suggestions were offered, taken
    // verbatim, taken with edits, and ignored. `discarded` is the honest signal
    // that the candidate actually read them.
    suggested: { type: Number, default: 0 },
    accepted: { type: Number, default: 0 },
    edited: { type: Number, default: 0 },
    discarded: { type: Number, default: 0 },
    // The candidate's explicit "I have reviewed these and they are accurate".
    // Separate from the data/AI consent: consent is permission to process,
    // attestation is authorship. An adverse action resting on a machine-written
    // claim the person never adopted is exactly what this record prevents.
    attestedAt: { type: Date },
    ipAddress: { type: String, trim: true },
    // How much of the deterministic score came from suggestions the candidate
    // accepted verbatim: score(as submitted) - score(with those fields removed).
    // Recorded, never subtracted — the candidate attested to the fields, so they
    // are legitimately theirs. It is here so the dependency is VISIBLE to a
    // recruiter and measurable in an audit rather than silently baked in.
    scoreDelta: { type: Number },
  },
  { _id: false }
);

const stageHistorySchema = new mongoose.Schema(
  {
    stage: { type: String, required: true },
    note: { type: String, trim: true },
    // Actor that drove the transition: an admin's name/email, or "system" for
    // automated moves (ATS, interview completion).
    by: { type: String, trim: true, default: "system" },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const offerSchema = new mongoose.Schema(
  {
    status: { type: String, enum: ["none", "sent", "accepted", "declined"], default: "none" },
    message: { type: String, trim: true },
    sentAt: { type: Date },
    respondedAt: { type: Date },
  },
  { _id: false }
);

const atsResultSchema = new mongoose.Schema(
  {
    skillsMatch: { type: Number, default: 0 },
    experienceMatch: { type: Number, default: 0 },
    educationMatch: { type: Number, default: 0 },
    projectsMatch: { type: Number, default: 0 },
    certificationMatch: { type: Number, default: 0 },
    keywordMatch: { type: Number, default: 0 },
    missingSkills: { type: [String], default: [] },
    overallScore: { type: Number, default: 0 },
    threshold: { type: Number },
    // "review" = the evidence engine's honest middle band (Phase 6) — a human
    // decides; it must never be treated as a fail by any consumer.
    decision: { type: String, enum: ["pending", "pass", "fail", "review"], default: "pending" },
    scoredAt: { type: Date },
    // Which engine produced the headline number: legacy keyword engine,
    // the evidence engine, or legacy-as-labelled-fallback after an evidence
    // failure. Uncertainty must be visible (engineering rule 5).
    engine: { type: String, enum: ["legacy", "evidence", "fallback-legacy"], default: "legacy" },
  },
  { _id: false }
);

// Hostility report from resumeDefenseService (Phase 4). Flags, never decides:
// nothing in here may drive an automated adverse action. Spans index into the
// canonical `resumeText` string (immutable once extracted).
const hostilitySpanSchema = new mongoose.Schema(
  {
    start: { type: Number, required: true },
    end: { type: Number, required: true },
    quote: { type: String, required: true },
    page: { type: Number, default: null },
  },
  { _id: false }
);

const hostilitySignalSchema = new mongoose.Schema(
  {
    code: { type: String, required: true },
    severity: { type: String, enum: ["critical", "warning", "advisory"], required: true },
    message: { type: String, required: true },
    spans: { type: [hostilitySpanSchema], default: [] },
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false }
);

const hostilitySchema = new mongoose.Schema(
  {
    version: { type: String },
    analyzedAt: { type: Date },
    engine: { type: String, enum: ["deterministic", "deterministic+llm", "disabled"] },
    signals: { type: [hostilitySignalSchema], default: [] },
    excludedFromModel: {
      type: [
        new mongoose.Schema(
          {
            start: { type: Number, required: true },
            end: { type: Number, required: true },
            quote: { type: String, required: true },
            codes: { type: [String], default: [] },
          },
          { _id: false }
        ),
      ],
      default: [],
    },
    clean: { type: Boolean, default: true },
  },
  { _id: false }
);

const candidateSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },

    basicDetails: {
      name: { type: String, required: true, trim: true },
      email: { type: String, required: true, trim: true, lowercase: true },
      phone: { type: String, trim: true },
      location: { type: String, trim: true },
      linkedinUrl: { type: String, trim: true },
      portfolioUrl: { type: String, trim: true },
    },

    experience: { type: [experienceSchema], default: [] },
    education: { type: [educationSchema], default: [] },
    skills: { type: [String], default: [] },
    skillProvenance: { type: [skillProvenanceSchema], default: [] },
    projects: { type: [projectSchema], default: [] },
    certificates: { type: [certificateSchema], default: [] },

    autofill: { type: autofillRecordSchema, default: () => ({ used: false }) },

    resumePath: { type: String, required: true },
    resumeOriginalName: { type: String },
    resumeSizeBytes: { type: Number }, // set at upload — feeds the storage quota (Phase 11)
    resumeText: { type: String, default: "" },
    // Link to the candidate's ResumeVersion (Phase 16 - Resume Version Manager)
    resumeVersion: { type: mongoose.Schema.Types.ObjectId, ref: "ResumeVersion" },
    // sha256 of the canonical resumeText — the identity key for ClaimGraph
    // reuse and the reproducibility hash (Phases 5-6).
    resumeHash: { type: String, default: "" },

    hostility: { type: hostilitySchema },

    ats: { type: atsResultSchema, default: () => ({}) },

    // Current hiring-pipeline stage. Ordered stages live in utils/pipeline.js;
    // `rejected` is the terminal off-ramp. Legacy values (interview_queue,
    // next_round) are normalized by the pipeline service before any save.
    status: {
      type: String,
      enum: [...STAGES, REJECTED],
      default: "applied",
    },

    // Append-only audit trail of every stage the candidate has passed through.
    stageHistory: { type: [stageHistorySchema], default: () => [] },

    // The recruiter gate decision (ASSESSMENT-ENGINE-PLAN §3 rule 8). Recorded so a
    // skipped assessment renders everywhere as "skipped by recruiter decision
    // (who, when)" — never as missing data — and so the awaiting-decision queue is
    // a query (ats_passed + no decision), not a hunt. `auto` = drive-mode bulk
    // assignment (A4.4), still a recorded human decision (creating the drive).
    assessmentDecision: {
      action: { type: String, enum: ["sent", "skipped"] },
      mode: { type: String, enum: ["manual", "auto"] },
      by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      byName: { type: String, trim: true },
      at: { type: Date },
    },

    offer: { type: offerSchema, default: () => ({}) },

    // Phase 15.1 — where this application came from (?src= on the apply link).
    // Analytics data ONLY: nothing in any scoring path may read this — a
    // referral must never score differently because it is a referral.
    source: {
      channel: { type: String, trim: true, lowercase: true, maxlength: 40 },
      campaign: { type: String, trim: true, maxlength: 80 },
      capturedAt: { type: Date },
    },

    // DPDP consent captured at application time. `aiProcessing` gates whether the
    // candidate's resume/answers may be sent to the external LLM — without it the
    // interview runs on the local deterministic engine so no PII leaves the system.
    consent: {
      aiProcessing: { type: Boolean, default: false },
      dataProcessing: { type: Boolean, default: false },
      at: { type: Date },
      ipAddress: { type: String, trim: true },
    },

    // Adjustments the candidate asked for. Recorded, honoured, and never a signal about them.
    //
    // Nothing here may reach a score, a recommendation, or anything a reviewer reads as a
    // property of the candidate. A request for an adjustment frequently discloses a disability;
    // treating it as information about the person is the exact harm the adjustment exists to
    // prevent, so it is stored to be ACTED ON and for nothing else.
    accommodations: {
      // Excludes this candidate from the spoken-communication assessment on roles that declare
      // one (RoleRubric.spokenCommunication). The exclusion is recorded on the session rather
      // than applied silently, so we can show we honoured it if we are ever asked.
      excludeSpokenCommunication: { type: Boolean, default: false },
      // What they asked for, in their words. Free text, for a human, never parsed.
      note: { type: String, trim: true, maxlength: 1000, default: "" },
      requestedAt: { type: Date },
    },

    // ─── Multi-role application identity (Phase 17) ─────────────────────────────
    // This document is ONE APPLICATION: one person → one job. The person's
    // permanent identity is their User account; `candidateUser` is the stable
    // relational link to it, and `candidateProfile` points at the 1:1
    // CandidateProfile. Both are set at apply time from the authenticated
    // session — never from a client-supplied value.
    //
    // `basicDetails.email` stays as the legacy/no-account fallback and keeps its
    // own uniqueness guard. Applications created before this field existed have
    // no `candidateUser` until the backfill script runs, so every "this person's
    // applications" query must match on (candidateUser OR basicDetails.email).
    candidateUser: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    candidateProfile: { type: mongoose.Schema.Types.ObjectId, ref: "CandidateProfile" },

    // Set when this application leaves the ACTIVE pipeline for a reason that is
    // not a recruiter's reject decision:
    //   hired_for_other_role — the same person was hired for a different role
    //                          here (pipelineService, on the `joined` move)
    //   job_filled           — the role filled all its openings and auto-closed
    //   job_closed           — a recruiter closed/unpublished the role
    //   job_deleted          — the role was deleted
    // The record is kept intact for audit/reporting — never deleted, never
    // forced to `rejected` (which would misreport the outcome). `status` keeps
    // whatever stage it had reached; the presence of `pipelineExit.at` is what
    // takes it off the board, and the UI derives its label from `reason`.
    // Cleared again if the role is re-published (job_closed / job_filled only).
    pipelineExit: {
      at: { type: Date },
      reason: {
        type: String,
        enum: ["hired_for_other_role", "job_filled", "job_closed", "job_deleted"],
      },
      // Only for hired_for_other_role — the winning role and application.
      hiredForJob: { type: mongoose.Schema.Types.ObjectId, ref: "Job" },
      hiredApplication: { type: mongoose.Schema.Types.ObjectId, ref: "Candidate" },
    },
  },
  { timestamps: true }
);

// Compound indexes matching the hot read paths (Wave 6 / F11). The leading `company`
// also serves the tenant-scope plugin's injected {company} equality, so the standalone
// single-field company index was dropped as a redundant prefix.
// Recruiter board lists a job's applicants newest-first (candidateController.listCandidatesForJob).
candidateSchema.index({ company: 1, job: 1, createdAt: -1 });
// Retention job scans a tenant's candidates by last-touched time (jobs/retentionJob).
candidateSchema.index({ company: 1, updatedAt: 1 });
// Analytics (overview / sources reports) scan a tenant's candidates by creation
// date range; without `job` in the predicate the {company,job,createdAt} index
// above can't serve the range, so it degrades to a full tenant scan.
candidateSchema.index({ company: 1, createdAt: -1 });
// Candidate dashboard + notification ownership resolve applications by the account email,
// across companies (runs outside tenant scope).
candidateSchema.index({ "basicDetails.email": 1 });
// One application per job per email — the race-proof duplicate guard behind the
// apply endpoint's 409 pre-check (a double-click must never create two
// Candidates, charge quota twice, or mint two interview links). Run
// scripts/syncIndexes.js after deploy; pre-existing duplicates must be merged
// or removed first or index creation fails.
candidateSchema.index({ job: 1, "basicDetails.email": 1 }, { unique: true });

// Multi-role (Phase 17): a person's applications across one company — the
// recruiter "related applications" panel, close-siblings-on-hire, and the
// distinct-candidate analytics count all read this path.
candidateSchema.index({ company: 1, candidateUser: 1, createdAt: -1 });
// The id-keyed twin of the (job, email) guard above: one application per
// (job, account). Partial so the many legacy rows with no `candidateUser` do
// not all collide on null — new applications are guarded by BOTH indexes.
candidateSchema.index(
  { job: 1, candidateUser: 1 },
  { unique: true, partialFilterExpression: { candidateUser: { $type: "objectId" } } }
);

candidateSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("Candidate", candidateSchema);
