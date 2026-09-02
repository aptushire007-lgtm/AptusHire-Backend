// A phrasing the trigger lists missed, and what a human decided to do about it.
//
// WHY THIS EXISTS. The deterministic tier matches word sequences: "repeat that" fires, "run that
// by me again" does not. The semantic tier covers the difference, and it works — but it means the
// interviewer pays a model call, every time, forever, for a phrasing that three candidates a week
// use. Worse, the trigger lists stay whatever a developer guessed once, and nobody ever finds out
// which guesses were wrong.
//
// The fix is already sitting in the data. Every time the semantic tier fires and returns something
// other than "they were answering", that utterance is BY DEFINITION a phrasing the lists missed —
// the deterministic tier ran first and said nothing. So each miss is recorded here, counted, and
// surfaced to the recruiter: "six candidates said something like this and we needed a model to
// understand it — should it just be a rule?" One approval turns it into a 0 ms deterministic
// trigger for that tenant, for every candidate after.
//
// The list stops being something a developer guessed and becomes something the candidates wrote.
//
// WHAT KEEPS THIS SAFE. A promoted phrase is a fast path, not a new power:
//
//   - It can only ever map to an action that already exists (utils/conversationIntent.ACTIONS).
//     Approving a phrase cannot invent a behaviour, only reach an existing one sooner.
//   - It runs through the SAME honour guards as the built-in triggers — a decline still has to be
//     essentially the whole of what was said, a withdrawal still has to be confirmed out loud, a
//     hand-back still has to follow a substantive answer. A bad approval makes the interviewer
//     misread a phrase; it cannot make it do something it could not already do.
//   - It is per-tenant. One company's vocabulary never changes another's interviews.
//   - It requires a human. Nothing is promoted because a counter got high.
//
// WHAT IS DELIBERATELY NOT STORED. The utterance only — never the answer it sat inside, never the
// candidate, never the session. What is useful here is the PHRASING, and the phrasing is the only
// part that generalises; keeping the rest would build a cross-candidate corpus of interview speech
// for no benefit that this feature needs.

const mongoose = require("mongoose");
const conversationIntent = require("../utils/conversationIntent");

// Promotable actions. `answer_continues` is excluded because it is the default and needs no
// trigger — a phrase that means "they were answering" is every phrase that matches nothing.
const PROMOTABLE_ACTIONS = conversationIntent.ACTION_NAMES.filter((a) => a !== "answer_continues");

const intentPhraseSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    // Which of the closed action set this phrasing was understood to mean.
    action: { type: String, enum: PROMOTABLE_ACTIONS, required: true },
    // The normalised form, used for grouping and for matching once approved. Lower-cased, single
    // spaces, no surrounding punctuation — the same shape the trigger matchers compare against.
    phrase: { type: String, required: true, trim: true, maxlength: 120 },
    // Exactly as the candidate said it, for the recruiter reviewing the proposal. Reviewing a
    // stripped-down normalised form makes it much harder to tell a real request from a fragment.
    example: { type: String, trim: true, maxlength: 200, default: "" },
    // proposed → the model kept reading this and a human has not looked yet
    // approved → it is now a deterministic trigger for this tenant
    // rejected → a human looked and said no; never proposed again
    status: { type: String, enum: ["proposed", "approved", "rejected"], default: "proposed", index: true },
    // How many times the semantic tier has had to read this phrasing. The whole argument for
    // promoting one: a phrase seen once is noise, a phrase seen twenty times is vocabulary.
    occurrences: { type: Number, default: 1 },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    // The confidence the classifier reported, averaged. A phrase the model was never sure about is
    // a phrase a human should look at harder, not one to make instant and irreversible.
    meanConfidence: { type: Number },
    decidedBy: {
      user: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      at: { type: Date },
    },
  },
  { timestamps: true }
);

// One row per (tenant, action, phrase). The upsert on every miss keys on exactly this.
intentPhraseSchema.index({ company: 1, action: 1, phrase: 1 }, { unique: true });
intentPhraseSchema.index({ company: 1, status: 1, occurrences: -1 });

intentPhraseSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("IntentPhrase", intentPhraseSchema);
module.exports.PROMOTABLE_ACTIONS = PROMOTABLE_ACTIONS;
