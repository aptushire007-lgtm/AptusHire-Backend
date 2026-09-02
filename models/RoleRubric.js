// Versioned, recruiter-approved hiring rubric for one job (BUILD-PLAN Phase 3).
// This object is the fairness mechanism and the audit artifact: every candidate
// for the role is scored against the byte-identical FROZEN version, which is
// what makes cross-candidate comparison legitimate and a bias audit possible.
//
// Lifecycle: draft (editable) → approved + frozenAt set (immutable) → archived
// (when a newer version is approved). A JD edit never mutates an existing
// rubric — it compiles a NEW draft version (rubricService.supersede), so
// historical decisions keep pointing at the exact object that made them.

const mongoose = require("mongoose");
const { CRITERION_KINDS, IMPORTANCE_KEYS } = require("../utils/rubricEngine");

const criterionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    // The tier WORD a human (or the compiler) actually chose. Persisted rather
    // than re-derived from `weight`, because the weight is a normalised fraction
    // that depends on the rest of the rubric — the choice is the audit fact, the
    // number is just its consequence. Absent on rubrics compiled before tiers
    // existed; rubricEngine.importanceOf falls back to `kind` for those.
    importance: { type: String, enum: IMPORTANCE_KEYS },
    // Derived from `importance`, never chosen separately. Legacy frozen rubrics
    // may still carry "disqualifier"; nothing authors one any more.
    kind: { type: String, enum: CRITERION_KINDS, required: true },
    // Normalised in code (rubricEngine.normaliseWeights): scoreable weights sum
    // to exactly 1.0; disqualifiers are gates and always carry 0.
    weight: { type: Number, required: true, min: 0, max: 1 },
    // Non-empty by schema (guardrail): trim + required rejects "".
    rationale: { type: String, required: true, trim: true },
    evidenceTypes: {
      type: [{ type: String, enum: ["skill", "experience", "education", "project", "certification", "outcome"] }],
      default: [],
    },
    acceptableEvidence: { type: [String], default: [] },
    probeHint: { type: String, trim: true, default: "" }, // feeds Phase 8 interview probes
    seniorityFloor: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const qualityFlagSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    severity: { type: String, enum: ["info", "warning", "critical"], default: "warning" },
    evidence: { type: String, trim: true }, // verbatim JD snippet that fired the flag
  },
  { _id: false }
);

const roleRubricSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    version: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ["draft", "approved", "archived"], default: "draft" },

    // sha256 of the canonical JD text this was compiled from (rubricEngine.sourceHashOf).
    sourceHash: { type: String, required: true, trim: true },

    criteria: { type: [criterionSchema], default: [] },

    // Whether this role assesses HOW WELL THE CANDIDATE COMMUNICATED, on top of what they said.
    //
    // Off unless a human turns it on, and it cannot be turned on without writing down why this
    // role requires it. That justification is not paperwork — job-relatedness is the entire legal
    // basis for assessing someone's communication, and a declaration with no stated reason is not
    // a declaration. It is frozen with the rubric like everything else here, so a decision
    // defended later can state that a named person decided this role needed it, and why.
    //
    // What is measured is derived from the TRANSCRIPT only (utils/communication.js) — never from
    // pace, filler rate, or hesitation, which are accent, nervousness and disability proxies. A
    // previous version of this feature scored those and was removed for it.
    //
    // The score is reported beside the competency scores and can route to a human. It never
    // enters the overall score and can never, by itself, reject anyone.
    spokenCommunication: {
      enabled: { type: Boolean, default: false },
      // Why this role needs it. A VALIDATOR rather than a save-time check, deliberately: it then
      // runs on `validateSync()` too, which means the rule can be exercised without a database and
      // therefore actually is. A guard that can only be tested against live Mongo is a guard
      // nobody re-tests after changing it.
      justification: {
        type: String,
        trim: true,
        default: "",
        maxlength: 600,
        validate: {
          validator(v) {
            if (!this.spokenCommunication?.enabled) return true;
            return Boolean(String(v || "").trim());
          },
          message:
            "Spoken communication cannot be assessed without a written justification of why this " +
            "role requires it — job-relatedness is the whole basis for assessing how a candidate speaks.",
        },
      },
      declaredBy: {
        user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        at: { type: Date },
      },
    },

    // Two thresholds, not one (Phase 6): >= advance ⇒ advance; < review ⇒ decline
    // (human-in-the-loop rules permitting); in between ⇒ route to human review.
    thresholds: {
      advance: { type: Number, min: 0, max: 100, default: 60 },
      review: { type: Number, min: 0, max: 100, default: 45 },
    },

    // Provenance (engineering rule 5 — degraded paths are labelled everywhere).
    compiledBy: {
      engine: { type: String, enum: ["ai", "fallback"], required: true },
      model: { type: String, trim: true },
      promptVersion: { type: String, trim: true },
      at: { type: Date },
    },
    approvedBy: {
      user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      at: { type: Date },
    },

    qualityFlags: { type: [qualityFlagSchema], default: [] },

    // Once set, the document is immutable (see hooks below).
    frozenAt: { type: Date },
  },
  { timestamps: true }
);

roleRubricSchema.index({ job: 1, version: 1 }, { unique: true });
roleRubricSchema.index({ company: 1, job: 1, status: 1 });
// Belt-and-braces against the "Compile"/"Recompile" button being clicked twice
// before the first request's LLM round-trip returns: rubricService.compile()
// already checks for an existing draft up front, but that check happens before
// the (multi-second) model call, so two near-simultaneous requests can both
// pass it. This partial unique index makes it impossible for two draft rows to
// ever exist for the same (job, sourceHash) at the DB layer — the loser's
// insert fails with E11000, and rubricService.compile() catches that and hands
// back the winner's draft instead of creating a duplicate.
roleRubricSchema.index(
  { job: 1, sourceHash: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "draft" } }
);

roleRubricSchema.path("thresholds.review").validate(function (v) {
  return !(Number.isFinite(v) && Number.isFinite(this.thresholds?.advance)) || v <= this.thresholds.advance;
}, "thresholds.review must not exceed thresholds.advance");

// --- Immutability (Phase 3 guardrail) ----------------------------------------
// A frozen rubric admits exactly ONE change: status → "archived" (how supersede
// retires an old approved version when its successor is approved). Everything
// else — criteria, weights, thresholds, flags — is rejected; changes create a
// new version, always.

// Pure checker, exported for unit tests: returns an error message, or null if
// the change is allowed. `modifiedPaths` may contain parent+child path entries.
function frozenViolation(wasFrozen, modifiedPaths, nextStatus) {
  if (!wasFrozen) return null;
  const disallowed = modifiedPaths.filter((p) => p !== "status" && p !== "updatedAt");
  if (disallowed.length) {
    return `RoleRubric is frozen — cannot modify [${disallowed.join(", ")}]; compile a new version instead`;
  }
  if (modifiedPaths.includes("status") && nextStatus !== "archived") {
    return `RoleRubric is frozen — status may only change to "archived", not "${nextStatus}"`;
  }
  return null;
}

// Capture frozen-ness at load time so a save can't dodge the guard by also
// overwriting frozenAt itself.
roleRubricSchema.post("init", function () {
  this.$locals.wasFrozen = Boolean(this.frozenAt);
});

roleRubricSchema.pre("save", function () {
  const violation = frozenViolation(Boolean(this.$locals?.wasFrozen), this.modifiedPaths(), this.status);
  if (violation) throw new Error(violation);
});

// Query-level updates bypass document middleware entirely, so they are banned
// outright for this collection — all writes go through load-modify-save in
// rubricService, where the frozen guard above can see them.
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne"]) {
  roleRubricSchema.pre(op, function () {
    throw new Error(`RoleRubric does not allow query-level ${op} — load the document and save via rubricService`);
  });
}

roleRubricSchema.plugin(require("./plugins/tenantScope"));

const RoleRubric = mongoose.model("RoleRubric", roleRubricSchema);
RoleRubric.frozenViolation = frozenViolation;
module.exports = RoleRubric;
