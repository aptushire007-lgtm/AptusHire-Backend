// The recruiter-approved must-ask question set for a job profile.
//
// WHY THIS EXISTS. Questions used to come from three places, none of them a thing a recruiter
// had approved: claim-probes generated per candidate, LLM generation at each turn, and a
// hardcoded generic pool as the no-key fallback. That makes every candidate's interview a
// slightly different test, which is precisely what makes cross-candidate comparison
// illegitimate and leaves nothing to point at when a decision is challenged.
//
// An approved set fixes the CORE of the instrument while leaving it able to react:
//   - every candidate for this job is asked all of these, verbatim, in order;
//   - on top of that they get their own résumé claim-probes and adaptive follow-ups.
// Identical core + candidate-specific probing. Comparable AND conversational.
//
// VERBATIM IS THE POINT. The model may follow up on an answer; it may never reword or skip an
// approved question. A reworded question is a different question, and "we asked everyone the
// same thing" stops being true the moment a model paraphrases for one candidate and not
// another. Selection and delivery of these are done by CODE (aiInterviewService), which is the
// same separation the product applies to scoring: the model reasons over text, code decides.
//
// Lifecycle mirrors RoleRubric and PersonaProfile: draft (editable) → approved + frozenAt
// (immutable) → archived. Changing an approved set means approving a NEW version, so an
// interview that already ran keeps pointing at the exact set of questions it actually asked.

const mongoose = require("mongoose");
const { vetQuestions, MAX_QUESTIONS_PER_SET } = require("../utils/questionVetting");

const questionSchema = new mongoose.Schema(
  {
    // Stable within a version. Coverage is tracked per id on the session, and the id is stamped
    // on the turn that asked it — so "which approved question produced this answer" is a lookup,
    // not a string comparison against text that may since have been superseded.
    id: { type: String, required: true, trim: true },
    text: { type: String, required: true, trim: true },
    // The same question in plainer words, for a candidate who heard it and did not understand it.
    //
    // Frozen HERE, alongside the question, and approved by the same human in the same act — which
    // is the only way a rephrasing can exist in this product. Composing one in the moment would
    // mean the candidate who asked was measurably asked a different question from everyone else,
    // and "we asked everyone the same thing" would stop being true for exactly the candidates who
    // needed the most help. Vetted to the same standard as the question itself
    // (utils/questionVetting), because it is spoken to the candidate in place of one.
    //
    // Optional. Empty means this question cannot be rephrased, and the interviewer says so by
    // repeating it rather than announcing a rewording it cannot deliver.
    restatement: { type: String, trim: true, default: "" },
    // Free-text grouping for the recruiter's own benefit ("system design", "ways of working").
    // Never used for scoring — the rubric owns what counts.
    topic: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const questionSetSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    // One set per job profile. The (company, job, version) triple is what a session stamp refers to.
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    version: { type: Number, required: true, min: 1, default: 1 },
    status: { type: String, enum: ["draft", "approved", "archived"], default: "draft" },

    questions: { type: [questionSchema], default: () => [] },

    // What this draft was compiled FROM (JD + rubric version + prompt version), so re-opening the
    // authoring screen returns the existing draft instead of recompiling and churning versions.
    // Absent on a hand-authored set.
    sourceHash: { type: String, index: true },
    // How it was produced. "fallback" means the deterministic anchors ran — no key, no budget, or
    // the provider failed — and it is labelled as such rather than passed off as a compiled set,
    // because a recruiter deciding whether to just click approve should know which they are
    // looking at.
    compiledBy: {
      engine: { type: String, enum: ["ai", "fallback"] },
      model: { type: String },
      promptVersion: { type: String },
      at: { type: Date },
    },
    // Questions the compiler proposed and the vetting gate REFUSED. Kept and surfaced rather than
    // silently discarded: "the model tried to ask about visa status and this blocked it" is
    // exactly the kind of thing a buyer should be able to watch working.
    droppedAtCompile: {
      type: [
        {
          text: { type: String },
          codes: { type: [String], default: () => [] },
          _id: false,
        },
      ],
      default: () => [],
    },

    // Human approval, as on RoleRubric: a set that decides what every candidate for this role is
    // asked does not go live because code decided it should.
    approvedBy: {
      user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      at: { type: Date },
    },
    frozenAt: { type: Date },
    notes: { type: String, trim: true, maxlength: 2000, default: "" },
  },
  { timestamps: true }
);

questionSetSchema.index({ company: 1, job: 1, version: 1 }, { unique: true });
questionSetSchema.index({ company: 1, job: 1, status: 1 });
// Mirrors RoleRubric's guard: two near-simultaneous "Recompile" clicks can both
// pass questionSetService.autoDraft's up-front existingDraft check before the
// slower one's LLM call returns. This makes a second draft for the same
// (job, sourceHash) impossible at the DB layer instead of only in application code.
// `sourceHash` is absent on hand-authored drafts (createDraft), so the filter also
// requires it to exist — otherwise every hand-authored draft for a job (all with no
// sourceHash) would collide on this same index.
questionSetSchema.index(
  { company: 1, job: 1, sourceHash: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: "draft", sourceHash: { $exists: true } } }
);

// --- Immutability, mirroring PersonaProfile ----------------------------------
// A frozen set admits exactly ONE change: status → "archived".

function frozenViolation(wasFrozen, modifiedPaths, nextStatus) {
  if (!wasFrozen) return null;
  const disallowed = modifiedPaths.filter((p) => p !== "status" && p !== "updatedAt");
  if (disallowed.length) {
    return `QuestionSet is frozen — cannot modify [${disallowed.join(", ")}]; approve a new version instead`;
  }
  if (modifiedPaths.includes("status") && nextStatus !== "archived") {
    return `QuestionSet is frozen — status may only change to "archived", not "${nextStatus}"`;
  }
  return null;
}

questionSetSchema.post("init", function () {
  this.$locals.wasFrozen = Boolean(this.frozenAt);
});

questionSetSchema.pre("save", function () {
  const violation = frozenViolation(Boolean(this.$locals?.wasFrozen), this.modifiedPaths(), this.status);
  if (violation) throw new Error(violation);

  // Vetting is enforced at the MODEL layer, not only in the service, so there is no route into
  // the database that skips it. A draft may hold work in progress; an approved set may not —
  // approval is the moment the text becomes something every candidate will be read.
  if (this.status === "approved") {
    const verdict = vetQuestions(this.questions);
    if (!verdict.ok) {
      const first = verdict.issues[0];
      throw new Error(
        `QuestionSet cannot be approved — ${verdict.issues.length} issue(s). ` +
          `First: ${first.index >= 0 ? `question ${first.index + 1}: ` : ""}${first.message}`
      );
    }
  }
  if (this.questions.length > MAX_QUESTIONS_PER_SET) {
    throw new Error(`QuestionSet is capped at ${MAX_QUESTIONS_PER_SET} questions`);
  }
});

// Query-level updates bypass document middleware, so they are banned outright — every write goes
// load-modify-save through questionSetService where the guards above can see it.
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne"]) {
  questionSetSchema.pre(op, function () {
    throw new Error(`QuestionSet does not allow query-level ${op} — load the document and save via questionSetService`);
  });
}

questionSetSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("QuestionSet", questionSetSchema);
module.exports.frozenViolation = frozenViolation;
