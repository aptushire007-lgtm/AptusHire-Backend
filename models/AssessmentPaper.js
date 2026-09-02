// AssessmentPaper (ASSESSMENT-ENGINE-PLAN A1.1) — the frozen test artifact for one
// job, mirroring RoleRubric's lifecycle exactly: draft (editable) → approved +
// frozenAt (immutable) → archived (when a newer version is approved).
//
// Design decisions that ARE the product:
//   - Every item is generated agentically from the frozen rubric and carries a
//     schema-REQUIRED `criterionId`: an item that maps to no rubric criterion
//     cannot exist. There is no cross-tenant bank and no generic library.
//   - Every item carries full generation provenance including the blind-solve
//     result (N solvers who never saw the key). An item the solvers disagreed on
//     is `flagged`, with the disagreement stored and shown — never silently kept.
//   - `key` is stored here but must NEVER be serialized to candidate-facing APIs.
//     Candidate payloads go through the allow-list in assessmentService.
//   - A frozen paper admits exactly three changes: status → archived, per-item
//     `exposure` telemetry counters (display-only, A5.1), and per-item
//     status → retired (A5.2 — excluded from FUTURE assembly only). Everything
//     else ⇒ new version. In-flight sessions keep the version they started on.

const mongoose = require("mongoose");

const ITEM_TYPES = ["mcq_single", "mcq_multi", "numeric", "ordering"];
const DIFFICULTIES = ["easy", "medium", "hard"];

const optionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },   // stable "a".."e" — answers reference these ids
    text: { type: String, required: true },
  },
  { _id: false }
);

// The pre-committed answer key. Shape depends on `type`:
//   mcq_single / mcq_multi → { optionIds: [String] }
//   numeric                → { value: Number, tolerance: Number }
//   ordering               → { order: [String] }  (option ids in correct sequence)
const keySchema = new mongoose.Schema(
  {
    optionIds: { type: [String], default: undefined },
    value: { type: Number },
    tolerance: { type: Number },
    order: { type: [String], default: undefined },
  },
  { _id: false }
);

const blindSolveSchema = new mongoose.Schema(
  {
    n: { type: Number, default: 0 },
    agreedWithKey: { type: Number, default: 0 },
    // What each solver answered (for the flagged-item disagreement display).
    solverAnswers: { type: [mongoose.Schema.Types.Mixed], default: [] },
    revisions: { type: Number, default: 0 },
  },
  { _id: false }
);

const itemSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    sectionId: { type: String, required: true },
    // The rubric criterion this item probes. Schema-required: no orphan items.
    criterionId: { type: String, required: true },
    targetsProbeHint: { type: Boolean, default: false },
    type: { type: String, enum: ITEM_TYPES, required: true },
    stem: { type: String, required: true },
    options: { type: [optionSchema], default: [] },
    key: { type: keySchema, required: true },
    difficulty: { type: String, enum: DIFFICULTIES, required: true },
    rationale: { type: String, default: "" },
    generation: {
      model: { type: String },
      promptVersion: { type: String },
      at: { type: Date },
      blindSolve: { type: blindSolveSchema, default: () => ({}) },
    },
    status: { type: String, enum: ["active", "flagged", "retired"], default: "active" },
    // A5.1 telemetry — display-only counters, the one permitted write post-freeze.
    exposure: {
      serves: { type: Number, default: 0 },
      corrects: { type: Number, default: 0 },
    },
  },
  { _id: false }
);

const sectionSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    criterionIds: { type: [String], default: [] },
    servedItemCount: { type: Number, required: true, min: 1 },
    poolItemCount: { type: Number, required: true, min: 1 },
    difficultyMix: {
      easy: { type: Number, default: 0, min: 0 },
      medium: { type: Number, default: 0, min: 0 },
      hard: { type: Number, default: 0, min: 0 },
    },
    timeLimitSec: { type: Number, required: true, min: 60 },
  },
  { _id: false }
);

const assessmentPaperSchema = new mongoose.Schema(
  {
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    rubric: { type: mongoose.Schema.Types.ObjectId, ref: "RoleRubric", required: true },
    rubricVersion: { type: Number, required: true },
    version: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ["draft", "approved", "archived"], default: "draft" },

    sections: { type: [sectionSchema], default: [] },
    items: { type: [itemSchema], default: [] },

    timing: {
      mode: { type: String, enum: ["overall", "per_section"], default: "per_section" },
      totalSec: { type: Number, min: 60 },
    },

    // Recruiter-set difficulty policy (A1.4). `fixed` serves every candidate the
    // fixedTier pool; `claim_tiered` picks the tier per candidate IN CODE from
    // their own extracted claims (A3.0) — recruiter override always wins.
    difficultyPolicy: {
      mode: { type: String, enum: ["fixed", "claim_tiered"], default: "fixed" },
      fixedTier: { type: String, enum: DIFFICULTIES, default: "medium" },
    },

    negativeMarking: { enabled: { type: Boolean, default: false } },

    // A4.2 soft-lock defaults (per-assignment overridable later). Default OFF:
    // flags are advisory, exactly like interview proctoring. When on, N flags
    // trigger `action`: "pause" (default — pings a human, fails open if
    // ignored) or "auto_submit" (ends the session immediately, no human
    // step; only counts the narrower AUTO_SUBMIT_TRIGGER_TYPES set, not every
    // high-severity type — see backend/utils/proctoring.js).
    integrityDefaults: {
      proctoring: { type: Boolean, default: true },
      softLock: {
        enabled: { type: Boolean, default: false },
        flagThreshold: { type: Number, default: 3, min: 1 },
        action: { type: String, enum: ["pause", "auto_submit"], default: "pause" },
      },
    },

    instructions: { type: String, trim: true, default: "" },

    // Item-generation run state (admin UI polls this; generation is async and
    // resumable — items persist as they pass the blind-solve gate).
    generationRun: {
      status: { type: String, enum: ["idle", "running", "completed", "failed"], default: "idle" },
      startedAt: { type: Date },
      finishedAt: { type: Date },
      // Liveness proof. The run loop exists only in the memory of the process that
      // started it, so `status: "running"` alone cannot distinguish "working" from
      // "the process died". The loop re-stamps this after every item it persists;
      // itemGenService.isRunStale() reads it to decide whether a run may be taken
      // over. Without it a killed process wedges the paper forever — Resume and
      // Approve both refuse, and the UI spins on a run that will never finish.
      heartbeatAt: { type: Date },
      generated: { type: Number, default: 0 },
      flagged: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      target: { type: Number, default: 0 },
      message: { type: String, default: "" },
    },

    compiledBy: {
      engine: { type: String, enum: ["ai"], required: true }, // NO fallback engine exists — no LLM ⇒ no paper (§3.5)
      model: { type: String, trim: true },
      promptVersion: { type: String, trim: true },
      at: { type: Date },
    },
    approvedBy: {
      user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      at: { type: Date },
    },
    frozenAt: { type: Date },
  },
  { timestamps: true }
);

assessmentPaperSchema.index({ job: 1, version: 1 }, { unique: true });
assessmentPaperSchema.index({ company: 1, job: 1, status: 1 });

// --- Immutability (same law as RoleRubric) -----------------------------------
// Pure checker, exported for unit tests. `itemStatusChanges` is a list of
// { from, to } for any item whose status this save modifies.
function frozenViolation(wasFrozen, modifiedPaths, nextStatus, itemStatusChanges = []) {
  if (!wasFrozen) return null;
  const allowed = (p) =>
    p === "status" ||
    p === "updatedAt" ||
    p === "items" || // parent path — the per-child checks below decide
    /^items\.\d+$/.test(p) ||
    /^items\.\d+\.status$/.test(p) ||
    /^items\.\d+\.exposure(\.|$)/.test(p);
  const disallowed = modifiedPaths.filter((p) => !allowed(p));
  if (disallowed.length) {
    return `AssessmentPaper is frozen — cannot modify [${disallowed.join(", ")}]; generate a new version instead`;
  }
  if (modifiedPaths.includes("status") && nextStatus !== "archived") {
    return `AssessmentPaper is frozen — status may only change to "archived", not "${nextStatus}"`;
  }
  for (const change of itemStatusChanges) {
    if (change.to !== "retired") {
      return `AssessmentPaper is frozen — an item's status may only change to "retired", not "${change.to}"`;
    }
  }
  return null;
}

assessmentPaperSchema.post("init", function () {
  this.$locals.wasFrozen = Boolean(this.frozenAt);
  this.$locals.itemStatuses = (this.items || []).map((i) => i.status);
});

assessmentPaperSchema.pre("save", function () {
  const prior = this.$locals?.itemStatuses || [];
  const itemStatusChanges = [];
  (this.items || []).forEach((item, idx) => {
    if (prior[idx] !== undefined && prior[idx] !== item.status) {
      itemStatusChanges.push({ from: prior[idx], to: item.status });
    }
  });
  const violation = frozenViolation(
    Boolean(this.$locals?.wasFrozen),
    this.modifiedPaths(),
    this.status,
    itemStatusChanges
  );
  if (violation) throw new Error(violation);
});

// Query-level updates bypass document middleware — banned outright, same as RoleRubric.
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne"]) {
  assessmentPaperSchema.pre(op, function () {
    throw new Error(`AssessmentPaper does not allow query-level ${op} — load the document and save via assessmentPaperService`);
  });
}

assessmentPaperSchema.plugin(require("./plugins/tenantScope"));

const AssessmentPaper = mongoose.model("AssessmentPaper", assessmentPaperSchema);
AssessmentPaper.frozenViolation = frozenViolation;
AssessmentPaper.ITEM_TYPES = ITEM_TYPES;
AssessmentPaper.DIFFICULTIES = DIFFICULTIES;
module.exports = AssessmentPaper;
