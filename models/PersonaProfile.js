// The interviewer's persona: who the candidate meets, what it sounds like, and how patient it is.
//
// Why this is a VERSIONED, APPROVED artifact rather than a settings blob:
//   Interviewer warmth is not decoration — it changes candidate behaviour. A patient, warm
//   interviewer gets longer and more candid answers than a clipped one, from the same candidate.
//   That makes the persona part of the TEST CONDITIONS, in exactly the sense the RoleRubric is:
//   comparing two candidates is only legitimate if both were interviewed under the same
//   conditions, and defending a decision means being able to state what those conditions were.
//   So the persona is versioned, frozen on approval, and stamped onto every session that used it
//   — the same lifecycle as the rubric, for the same reason.
//
// What a persona may and may not decide:
//   - MAY: the interviewer's name, its voice, and how long it waits before treating silence as
//     the end of a turn.
//   - MAY NOT: anything about the questions. Question authorship stays in aiInterviewService,
//     compiled from the versioned rubric and the candidate's claim probes. A persona is a
//     RENDERER, never an AUTHOR — that separation is what keeps the test instrument auditable
//     while the delivery gets to feel human.
//   - MAY NOT: the reassurance/acknowledgement wording. Those come from the fixed,
//     code-resident, non-evaluative bank in utils/backchannel.js, which is checked at boot for
//     evaluative language. Letting each tenant write its own would reintroduce exactly the
//     differential-encouragement bias the bank exists to prevent.
//
// Lifecycle mirrors RoleRubric: draft (editable) → approved + frozenAt (immutable) → archived.
// Changing an approved persona means approving a NEW version, so a past interview keeps pointing
// at the exact conditions it actually ran under.

const mongoose = require("mongoose");

// Hard bounds on tenant-set patience. The floor exists because the whole point of this work is
// that candidates get thinking room — a tenant must not be able to configure the interviewer
// back into cutting people off mid-sentence. The ceiling stops a misconfiguration from stranding
// a candidate in a silent room for minutes.
const PATIENCE_BOUNDS = {
  maxReassurancesPerTurn: { min: 0, max: 4 },
  postReassuranceGraceMs: { min: 4000, max: 30000 },
  initialSilenceMs: { min: 3000, max: 30000 },
};

const personaProfileSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    // Stable identifier across versions ("default", "graduate-warm", …). The (company, key,
    // version) triple is what a session stamp refers to.
    key: { type: String, required: true, trim: true, lowercase: true, default: "default" },
    version: { type: Number, required: true, min: 1, default: 1 },
    status: { type: String, enum: ["draft", "approved", "archived"], default: "draft" },

    // The name the candidate hears and sees. Recruiter-authored, and therefore the tenant's own
    // content in the same way a job description is — but capped and versioned, so what a given
    // candidate was told is always recoverable.
    //
    // (No tenant-authored spoken lines live here on purpose. A custom greeting would be
    // interviewer speech that is NOT in the approved bank, which means it could not be
    // echo-stripped or boot-checked like the bank is — it needs its own recording story before it
    // can exist. Shipping the field ahead of that wiring is how this codebase ended up with a
    // declared-but-never-written `audioPath` once already.)
    name: { type: String, required: true, trim: true, maxlength: 60 },

    // Voice. `model` is provider-specific (e.g. a Deepgram Aura voice id); `provider` records
    // which speech vendor that id belongs to so a vendor swap can't silently repoint it at a
    // different-sounding voice.
    voice: {
      provider: { type: String, trim: true, default: "deepgram" },
      model: { type: String, trim: true, default: "" }, // empty ⇒ the deployment default voice
    },

    // How patient the interviewer is. Overrides the deployment defaults in
    // utils/backchannel.clientPolicy() for this tenant, within PATIENCE_BOUNDS.
    patience: {
      maxReassurancesPerTurn: { type: Number },
      postReassuranceGraceMs: { type: Number },
      initialSilenceMs: { type: Number },
    },

    // Human approval, as on RoleRubric: a persona that shapes interview conditions does not go
    // live because code decided it should.
    approvedBy: {
      user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      at: { type: Date },
    },
    frozenAt: { type: Date },
    notes: { type: String, trim: true, maxlength: 2000, default: "" },
  },
  { timestamps: true }
);

personaProfileSchema.index({ company: 1, key: 1, version: 1 }, { unique: true });
personaProfileSchema.index({ company: 1, status: 1 });

// --- Patience bounds ---------------------------------------------------------

function patienceViolation(patience) {
  for (const [field, bound] of Object.entries(PATIENCE_BOUNDS)) {
    const v = patience?.[field];
    if (v === undefined || v === null) continue;
    if (!Number.isFinite(v) || v < bound.min || v > bound.max) {
      return `patience.${field} must be between ${bound.min} and ${bound.max} (got ${v})`;
    }
  }
  return null;
}

// --- Immutability, mirroring RoleRubric --------------------------------------
// A frozen persona admits exactly ONE change: status → "archived". Everything else creates a new
// version, so an interview that already ran keeps pointing at the conditions it ran under.

function frozenViolation(wasFrozen, modifiedPaths, nextStatus) {
  if (!wasFrozen) return null;
  const disallowed = modifiedPaths.filter((p) => p !== "status" && p !== "updatedAt");
  if (disallowed.length) {
    return `PersonaProfile is frozen — cannot modify [${disallowed.join(", ")}]; approve a new version instead`;
  }
  if (modifiedPaths.includes("status") && nextStatus !== "archived") {
    return `PersonaProfile is frozen — status may only change to "archived", not "${nextStatus}"`;
  }
  return null;
}

// Capture frozen-ness at load time so a save can't dodge the guard by also overwriting frozenAt.
personaProfileSchema.post("init", function () {
  this.$locals.wasFrozen = Boolean(this.frozenAt);
});

personaProfileSchema.pre("save", function () {
  const violation = frozenViolation(Boolean(this.$locals?.wasFrozen), this.modifiedPaths(), this.status);
  if (violation) throw new Error(violation);
  const bad = patienceViolation(this.patience);
  if (bad) throw new Error(bad);
});

// Query-level updates bypass document middleware entirely, so they are banned outright — all
// writes go load-modify-save through personaService, where the guards above can see them.
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne"]) {
  personaProfileSchema.pre(op, function () {
    throw new Error(`PersonaProfile does not allow query-level ${op} — load the document and save via personaService`);
  });
}

personaProfileSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("PersonaProfile", personaProfileSchema);
module.exports.PATIENCE_BOUNDS = PATIENCE_BOUNDS;
module.exports.frozenViolation = frozenViolation;
module.exports.patienceViolation = patienceViolation;
