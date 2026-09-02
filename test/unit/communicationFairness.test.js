// Spoken communication can be assessed fairly, or it cannot be assessed. These are the gates.
//
// The previous version of this feature scored `delivery` and `confidence` from pace, filler rate
// and pause ratio, wrote them onto the evaluation beside the competency scores, and printed them
// to recruiters. Every one of those inputs is a proxy for something a hiring decision may not
// rest on: non-native speakers speak slower in the interview language, filler rate rises with
// nerves and with several speech differences, pause ratio rises with a stammer or a bad line.
//
// It was rebuilt rather than restored. The field names are the same; the inputs are not. What is
// measured now comes from the TRANSCRIPT, which is accent-neutral by construction — the same
// words are the same words however they were said.
//
// Each test below pins one property that makes that claim true rather than aspirational.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const communication = require("../../utils/communication");
const interviewPrompts = require("../../utils/interviewPrompts");
const RoleRubric = require("../../models/RoleRubric");

const TRANSCRIPT =
  "I rebuilt the ingestion path onto Kafka across four services, and the p99 went from about " +
  "nine seconds down to under two hundred milliseconds.";

const CLEAN_EXTRACTION = {
  answersTheQuestion: { value: true, quote: "I rebuilt the ingestion path onto Kafka" },
  hasConcreteExample: { value: true, quote: "the p99 went from about nine seconds" },
  termsAreExplained: { value: true, quote: "across four services" },
  referencesAreResolvable: { value: true, quote: "I rebuilt the ingestion path" },
  statedUncertaintyWhereItExisted: { value: false, quote: "" },
  overclaimed: { value: false, quote: "" },
  ownContributionIsClear: { value: true, quote: "I rebuilt the ingestion path onto Kafka" },
};

test("the same words score the same however they were spoken", () => {
  // The structural guarantee. Two candidates say the IDENTICAL sentence — one quickly and
  // fluently, one slowly and full of hesitation. Under the old scorer the first beat the second by
  // design. There is now no path from a microphone to this number, so they cannot differ.
  const scored = communication.scoreAnswer(CLEAN_EXTRACTION, TRANSCRIPT);

  const fluent = { wordsPerMinute: 180, fillerRate: 0, pauseRatio: 0.08, audioQuality: 96 };
  const halting = { wordsPerMinute: 58, fillerRate: 34, pauseRatio: 0.71, audioQuality: 41 };
  const turn = (acoustic) => ({
    role: "candidate",
    kind: "answer",
    inputMode: "voice",
    acoustic,
    communication: scored,
  });

  assert.deepEqual(
    communication.aggregate([turn(fluent)]),
    communication.aggregate([turn(halting)]),
    "an interview's communication score must not move with how the candidate sounded"
  );
});

test("a clear halting answer beats a fluent vague one", () => {
  // The reversal that is the entire point. State the outcome plainly so it cannot be tuned away
  // by accident: clarity is about what reached the listener, not about how smoothly it arrived.
  const vague = communication.scoreAnswer(
    {
      answersTheQuestion: { value: true, quote: "we moved it over" },
      hasConcreteExample: { value: false, quote: "" },
      termsAreExplained: { value: false, quote: "" },
      referencesAreResolvable: { value: false, quote: "" },
      statedUncertaintyWhereItExisted: { value: false, quote: "" },
      overclaimed: { value: false, quote: "" },
      ownContributionIsClear: { value: false, quote: "" },
    },
    "So basically we moved it over and it all worked out fine in the end, yeah."
  );
  const clear = communication.scoreAnswer(CLEAN_EXTRACTION, TRANSCRIPT);
  assert.ok(clear.delivery > vague.delivery, "the specific answer must win, regardless of delivery style");
});

test("hedging counts FOR a candidate; overclaiming counts against", () => {
  // `confidence` used to be filler rate times four plus a hesitation penalty — a personality read
  // that punished exactly the candidate who was being careful about what they knew. It now means
  // calibration, and the direction is inverted deliberately.
  const transcript =
    "I am not certain of the exact figure, but the order of magnitude was thousands of events a " +
    "second, and I wrote the consumer rebalancing logic myself.";
  const shared = {
    answersTheQuestion: { value: true, quote: "the order of magnitude was thousands" },
    hasConcreteExample: { value: true, quote: "thousands of events a second" },
    termsAreExplained: { value: true, quote: "consumer rebalancing logic" },
    referencesAreResolvable: { value: true, quote: "I wrote the consumer rebalancing logic myself" },
    ownContributionIsClear: { value: true, quote: "I wrote the consumer rebalancing logic myself" },
  };

  const careful = communication.scoreAnswer(
    { ...shared, statedUncertaintyWhereItExisted: { value: true, quote: "I am not certain of the exact figure" }, overclaimed: { value: false, quote: "" } },
    transcript
  );
  const overclaiming = communication.scoreAnswer(
    { ...shared, statedUncertaintyWhereItExisted: { value: false, quote: "" }, overclaimed: { value: true, quote: "thousands of events a second" } },
    transcript
  );

  assert.ok(
    careful.confidence > overclaiming.confidence,
    "saying what you are unsure of must not cost you — that was the old scorer's defining error"
  );
  // And how sure they were is not how clear they were: the two dimensions do not leak.
  assert.equal(careful.delivery, overclaiming.delivery);
});

test("an observation that cannot be quoted is dropped, not scored", () => {
  // Cite or abstain, applied to communication. A model that says "yes, they gave a concrete
  // example" and cannot point at one is reporting its impression of the candidate — which is the
  // thing this whole design exists to keep out of the number.
  const transcript = "We moved it over and it worked out fine in the end.";
  const r = communication.scoreAnswer(
    {
      answersTheQuestion: { value: true, quote: "We moved it over" },
      hasConcreteExample: { value: true, quote: "reduced p99 latency by ninety percent" }, // never said
      termsAreExplained: { value: true, quote: "" }, // no quote at all
      referencesAreResolvable: { value: false, quote: "" },
      statedUncertaintyWhereItExisted: { value: false, quote: "" },
      overclaimed: { value: false, quote: "" },
      ownContributionIsClear: { value: false, quote: "" },
    },
    transcript
  );
  assert.equal(r.features.hasConcreteExample, undefined, "a fabricated quote earns nothing");
  assert.equal(r.features.termsAreExplained, undefined, "a true with no quote earns nothing");
  // A `false` needs no quote — there is nothing to cite about an absence, and demanding one would
  // push the model to invent it.
  assert.equal(r.features.referencesAreResolvable.value, false);
  assert.ok(r.evidence.delivery.verified < r.evidence.delivery.of, "the gap is reported, never hidden");
});

test("too little verified evidence is 'not measured', never a low score", () => {
  const r = communication.scoreAnswer({}, "Sure.");
  assert.equal(r.delivery, undefined, "an unmeasurable answer must not score zero");
  assert.equal(r.confidence, undefined);
  assert.equal(communication.aggregate([]), null);
  assert.equal(communication.aggregate([{ role: "candidate", kind: "answer" }]), null);
});

test("a penalty cannot also shrink the scale it is measured against", () => {
  // Guards the arithmetic: `overclaimed` carries a negative weight, and if it were included in the
  // denominator, being penalised would make the remaining positives worth MORE and could raise the
  // score. Verified by construction rather than by reading the formula.
  const transcript = "I owned the migration end to end and it cut costs by half.";
  const base = {
    answersTheQuestion: { value: true, quote: "I owned the migration end to end" },
    hasConcreteExample: { value: true, quote: "cut costs by half" },
    termsAreExplained: { value: true, quote: "I owned the migration end to end" },
    referencesAreResolvable: { value: true, quote: "I owned the migration end to end" },
    statedUncertaintyWhereItExisted: { value: false, quote: "" },
    ownContributionIsClear: { value: true, quote: "I owned the migration end to end" },
  };
  const honest = communication.scoreAnswer({ ...base, overclaimed: { value: false, quote: "" } }, transcript);
  const inflated = communication.scoreAnswer({ ...base, overclaimed: { value: true, quote: "cut costs by half" } }, transcript);
  assert.ok(inflated.confidence < honest.confidence);
  assert.ok(inflated.confidence >= 0);
});

test("assessing how someone speaks requires a declared, justified reason", () => {
  // Off unless a human turned it on AND wrote down why this role needs it. Job-relatedness is the
  // entire legal basis for assessing communication; a switch with no reason beside it is not a
  // declaration. An accommodation overrides the role, always.
  assert.equal(communication.isEnabled(null), false, "no rubric ⇒ not assessed");
  assert.equal(communication.isEnabled({}), false);
  assert.equal(communication.isEnabled({ spokenCommunication: { enabled: true } }), false, "no reason, no assessment");
  assert.equal(
    communication.isEnabled({ spokenCommunication: { enabled: true, justification: "   " } }),
    false,
    "whitespace is not a justification"
  );
  const declared = {
    spokenCommunication: {
      enabled: true,
      justification: "Client-facing role: candidates present findings to non-technical stakeholders weekly.",
    },
  };
  assert.equal(communication.isEnabled(declared), true);
  assert.equal(communication.isEnabled(declared, { excluded: true }), false, "an accommodation overrides the role");
});

test("the database refuses to store the switch without the reason", () => {
  // Enforced at the model layer, not only in the service, so there is no route into the database
  // that assesses how someone speaks with no recorded basis — and "the UI usually asks" is not a
  // control.
  const make = (justification) =>
    new RoleRubric({
      job: new mongoose.Types.ObjectId(),
      company: new mongoose.Types.ObjectId(),
      version: 1,
      sourceHash: "a".repeat(64),
      compiledBy: { engine: "ai" },
      spokenCommunication: { enabled: true, justification },
    });

  const blank = make("").validateSync();
  assert.ok(blank, "a switch with no reason must not validate");
  assert.match(String(blank.errors["spokenCommunication.justification"]?.message), /justification/i);

  // With a reason, the declaration is valid.
  const declared = make("Support role: explaining fixes to customers is most of the job.").validateSync();
  assert.equal(declared?.errors?.["spokenCommunication.justification"], undefined);

  // And leaving it off needs no reason at all — the default state is simply not assessed, which
  // is what every role gets until somebody decides otherwise.
  const off = make("");
  off.spokenCommunication.enabled = false;
  assert.equal(off.validateSync()?.errors?.["spokenCommunication.justification"], undefined);
});

test("no feature measures the manner of speech", () => {
  // The guard against a quiet revert. Anything named for pace, fluency, hesitation, filler,
  // accent or tone would put the old scorer back under a new name — which is exactly how this
  // kind of thing comes back.
  const banned = /(pace|speed|fluen|hesitat|filler|stammer|stutter|accent|tone|pitch|volume|articulat|pronoun[cd])/i;
  for (const name of communication.FEATURE_NAMES) {
    assert.ok(!banned.test(name), `"${name}" measures how they spoke, not what they communicated`);
  }
  // And the acoustics never reach the model to begin with — the prompt is handed the question and
  // the transcript, and there is nothing else in it to be tempted by.
  const promptText = interviewPrompts.communicationPrompt({ question: "Tell me about it?", answer: "We did it." });
  assert.ok(!/wordsPerMinute|fillerRate|pauseRatio|words per minute/i.test(promptText));
  assert.ok(/transcript/i.test(promptText), "the prompt states what it is reading");
  // False starts and repetition are normal speech and the prompt must say so explicitly, or the
  // model will read ordinary spoken delivery as a communication failure.
  assert.ok(/false starts/i.test(promptText));
});

test("the score is reported, never decisive", () => {
  // It sits beside the competency scores and can route to a human. It is not in overallScore and
  // cannot reject anyone — the same rule every other automated adverse signal here lives under.
  const scored = communication.scoreAnswer(CLEAN_EXTRACTION, TRANSCRIPT);
  const agg = communication.aggregate([
    { role: "candidate", kind: "answer", communication: scored },
  ]);
  assert.ok(agg.delivery >= 0 && agg.delivery <= 100);
  assert.equal(agg.answersScored, 1);
  // A declined question contributes nothing: "I don't know" is not a communication failure.
  assert.equal(
    communication.aggregate([{ role: "candidate", kind: "answer", declined: true, communication: scored }]),
    null
  );
});
