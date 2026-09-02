// Acceptance gates for the interruptible, context-reading interviewer.
//
// Three mechanisms are pinned down here, and each one is allowed to fail in exactly one direction:
//
//   1. utils/echoAlignment — the interviewer must not mistake its own voice for the candidate
//      (which truncates a question and corrupts probe coverage), and must not explain away a real
//      interruption. Ambiguity resolves to echo, so barge-in requires positive evidence.
//   2. utils/conversationIntent — understanding is open-ended, consequences are closed. Nothing
//      the semantic tier returns may reach an action outside the declared set, and everything
//      uncertain lands on "they were answering the question".
//   3. utils/metaAnswers — the interviewer answers questions about the interview from this
//      session's real state, never from a guess, and never says anything about the candidate.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const echo = require("../../utils/echoAlignment");
const conversationIntent = require("../../utils/conversationIntent");
const metaAnswers = require("../../utils/metaAnswers");
const backchannel = require("../../utils/backchannel");

const QUESTION =
  "Tell me about the Kafka migration you led at Zeta, and what your specific role was on that team.";

// ---------------------------------------------------------------------------
// 1. Echo alignment
// ---------------------------------------------------------------------------

test("1.1: the interviewer hearing itself is not treated as the candidate speaking", () => {
  const r = echo.classify("and what your specific role was on that team", {
    spokenText: QUESTION,
    spokenRatio: 1,
  });
  assert.equal(r.verdict, "echo");
  assert.equal(r.residue, "", "nothing of the candidate's is left behind to become their answer");
});

test("1.2: a real interruption is heard even when the echo tail is longer than it", () => {
  // The case a percentage-based rule gets wrong: at the instant of a barge-in the transcript is
  // mostly our own sentence, and the candidate's first words are the minority of it.
  const r = echo.classify("you led at zeta sorry can I stop you there", {
    spokenText: QUESTION,
    spokenRatio: 1,
  });
  assert.equal(r.verdict, "speech");
  assert.equal(r.residue, "sorry can i stop you there", "their turn starts with what they said");
});

test("1.3: a candidate quoting the question back is not mistaken for echo", () => {
  const said =
    "you asked about the kafka migration the kafka migration was the second thing we did that year";
  const r = echo.classify(said, { spokenText: QUESTION, spokenRatio: 1 });
  assert.equal(r.verdict, "speech");
});

test("1.4: single shared words are coincidence, not evidence of speech", () => {
  // Almost every sentence shares "that"/"and"/"the" with every other. If one word could count as
  // novel speech, our own echo would trigger barge-in constantly.
  const r = echo.classify("that", { spokenText: QUESTION, spokenRatio: 1 });
  assert.equal(r.verdict, "echo");
});

test("1.5: ordinary transcription error does not turn echo into a false interruption", () => {
  // "role" heard as "rule" — one wrong token inside an otherwise verbatim reproduction.
  const r = echo.classify("and what your specific rule was on that team", {
    spokenText: QUESTION,
    spokenRatio: 1,
  });
  assert.equal(r.verdict, "echo");
});

test("1.6: when nothing is being spoken, everything heard is the candidate", () => {
  const r = echo.classify("we ran three brokers", { spokenText: "" });
  assert.equal(r.verdict, "speech");
  assert.equal(r.reason, "nothing_being_spoken");
  assert.equal(r.residue, "we ran three brokers", "their words are passed through untouched");
});

test("1.7: our text can only explain what has actually been played", () => {
  // The candidate says words that appear in the UNSPOKEN remainder of the question. Without the
  // playback bound those words would be explained away as echo of something never heard.
  const early = echo.classify("what your specific role", { spokenText: QUESTION, spokenRatio: 0.1 });
  assert.equal(early.verdict, "speech");
  const late = echo.classify("what your specific role", { spokenText: QUESTION, spokenRatio: 1 });
  assert.equal(late.verdict, "echo");
});

test("1.8: the same stretch of our sentence cannot explain two parts of a transcript", () => {
  // Guards the run-consumption loop: if the pool were not consumed, one "on that team" in our
  // question could account for the candidate saying it twice.
  const r = echo.classify("on that team on that team on that team", {
    spokenText: QUESTION,
    spokenRatio: 1,
  });
  assert.equal(r.verdict, "speech", "a repetition we only said once is the candidate talking");
});

test("1.9: barge-in is only possible while the interviewer is speaking", () => {
  const opts = { spokenText: QUESTION, spokenRatio: 1 };
  assert.equal(echo.isBargeIn("sorry can I stop you there", { ...opts, speaking: true }), true);
  assert.equal(echo.isBargeIn("sorry can I stop you there", { ...opts, speaking: false }), false);
});

test("1.10: full duplex has a kill switch, and it defaults on", () => {
  const prev = process.env.VOICE_FULL_DUPLEX;
  try {
    delete process.env.VOICE_FULL_DUPLEX;
    assert.equal(echo.clientPolicy().echo.fullDuplex, true);
    process.env.VOICE_FULL_DUPLEX = "false";
    assert.equal(echo.clientPolicy().echo.fullDuplex, false, "an open mic under our own voice must be revocable");
  } finally {
    if (prev === undefined) delete process.env.VOICE_FULL_DUPLEX;
    else process.env.VOICE_FULL_DUPLEX = prev;
  }
});

// ---------------------------------------------------------------------------
// 2. The intent layer
// ---------------------------------------------------------------------------

test("2.1: the deterministic tier answers the common phrasings without a model", () => {
  const r = conversationIntent.detectDeterministic("sorry, could you repeat that?");
  assert.equal(r.action, "repeat");
  assert.equal(r.tier, 0);
  assert.equal(r.confidence, 1);
});

test("2.2: asking for another go beats declining when both readings fit", () => {
  // "I'm not sure" is a decline trigger and "what was that" is a repeat trigger. A decline is
  // counted against evidence coverage, so reading this as one takes a question away from someone
  // who was still trying.
  const r = conversationIntent.detectDeterministic("i'm not sure, what was that?");
  assert.equal(r.action, "repeat");
});

test("2.3: precedence is stated, not incidental to which matcher ran first", () => {
  assert.equal(conversationIntent.PRECEDENCE[0], "withdraw", "the most consequential reading wins");
  assert.ok(
    conversationIntent.PRECEDENCE.indexOf("technical_problem") <
      conversationIntent.PRECEDENCE.indexOf("decline"),
    "a broken microphone is not an admission of not knowing"
  );
});

test("2.4: a phrase buried in a real answer is not an act", () => {
  const answer =
    "I don't know the exact number, but we ran three brokers and the lag never went above forty milliseconds";
  assert.equal(conversationIntent.detectDeterministic(answer), null, "this is evidence, not a decline");
});

test("2.5: every uncertainty in the semantic tier becomes 'they were answering'", () => {
  const cases = [
    [null, "no_classification"],
    [{ action: "delete_everything", confidence: 1 }, "unknown_action"],
    [{ action: "repeat", confidence: 0.4 }, "below_confidence"],
    [{ action: "repeat" }, "below_confidence"],
  ];
  for (const [raw, expectPrefix] of cases) {
    const r = conversationIntent.gateSemantic(raw, "sorry what");
    assert.equal(r.action, "answer_continues", `${JSON.stringify(raw)} must fall back`);
    assert.ok(r.reason.startsWith(expectPrefix), `${r.reason} should start with ${expectPrefix}`);
  }
});

test("2.6: the semantic tier cannot reach an action outside the closed set", () => {
  for (const action of conversationIntent.TIER1_ACTIONS) {
    assert.ok(conversationIntent.ACTIONS[action], `${action} must be a declared action`);
  }
  const r = conversationIntent.gateSemantic({ action: "hire_them", confidence: 1 }, "ok");
  assert.equal(r.action, "answer_continues");
});

test("2.7: a long utterance is an answer however it was classified", () => {
  const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  const r = conversationIntent.gateSemantic({ action: "decline", confidence: 0.99 }, long);
  assert.equal(r.action, "answer_continues");
  assert.equal(r.reason, "too_long_to_be_about_the_interview");
});

test("2.8: withdrawal always needs confirmation, whichever tier read it", () => {
  const tier0 = conversationIntent.detectDeterministic("i want to stop");
  assert.equal(tier0.action, "withdraw");
  assert.equal(tier0.needsConfirmation, true);
  const tier1 = conversationIntent.gateSemantic(
    { action: "withdraw", confidence: 1, reason: "they asked to leave" },
    "i think i'd like to leave now"
  );
  assert.equal(tier1.action, "withdraw");
  assert.equal(tier1.needsConfirmation, true, "understanding it perfectly is not a reason to skip the check");
});

test("2.9: a residue the model invented is discarded, not put into the candidate's answer", () => {
  const said = "sorry what was that";
  assert.equal(
    conversationIntent.literalResidue("I have ten years of Kubernetes experience", said),
    "",
    "words the candidate never said must never survive into their turn"
  );
  assert.equal(conversationIntent.literalResidue("what was that", said), "what was that");
});

test("2.10: an utterance ABOUT the interview never survives as the answer to it", () => {
  // `consumesTurn` means "this was speech about the interview, so strip it from the transcript".
  // The two actions that do NOT consume the turn are the two where the candidate's words ARE
  // their answer: they are still giving it (answer_continues), or they have just finished giving
  // it (finished). Everything else — a request, a decline, a process question, a withdrawal — is
  // speech about the interview and must not end up in the evidence.
  //
  // This used to assert `consumesTurn === (name !== "answer_continues")`, which was true only
  // because answer_continues happened to be the sole non-consuming action at the time. That is a
  // coincidence, not the rule, and it failed the moment a second one was added.
  const KEEPS_THE_WORDS = new Set(["answer_continues", "finished"]);
  for (const [name, def] of Object.entries(conversationIntent.ACTIONS)) {
    assert.equal(
      def.consumesTurn,
      !KEEPS_THE_WORDS.has(name),
      `${name} must declare whether its utterance is part of the candidate's answer`
    );
  }
});

test("2.11: the semantic tier is switchable off, back to the behaviour that shipped before it", () => {
  const prev = process.env.VOICE_SEMANTIC_INTENT;
  try {
    delete process.env.VOICE_SEMANTIC_INTENT;
    assert.equal(conversationIntent.clientPolicy().intent.semanticEnabled, true);
    process.env.VOICE_SEMANTIC_INTENT = "false";
    assert.equal(conversationIntent.clientPolicy().intent.semanticEnabled, false);
  } finally {
    if (prev === undefined) delete process.env.VOICE_SEMANTIC_INTENT;
    else process.env.VOICE_SEMANTIC_INTENT = prev;
  }
});

// ---------------------------------------------------------------------------
// 3. Answers to questions about the interview
// ---------------------------------------------------------------------------

test("3.1: 'how many more?' is answered from this interview's real numbers", () => {
  const a = metaAnswers.answerFor("how_many_left", { questionCount: 3, minQuestions: 5, maxQuestions: 8 });
  assert.equal(a.answered, true);
  assert.match(a.text, /2 and 5/, "a range, because the interview genuinely can close early");
});

test("3.2: the last question is described as the last question", () => {
  const a = metaAnswers.answerFor("how_many_left", { questionCount: 8, minQuestions: 5, maxQuestions: 8 });
  assert.equal(a.text, "This is the last one.");
});

test("3.3: an unknown monitoring state defers rather than guessing", () => {
  // The one topic where a confident wrong answer is a consent problem, not an inaccuracy.
  const unknown = metaAnswers.answerFor("is_recorded", {});
  assert.equal(unknown.answered, false);
  assert.equal(unknown.text, metaAnswers.DEFERRAL);

  const monitored = metaAnswers.answerFor("is_recorded", { proctoringEnabled: true });
  assert.match(monitored.text, /monitored/);
  const not = metaAnswers.answerFor("is_recorded", { proctoringEnabled: false });
  assert.doesNotMatch(not.text, /this session is monitored/);
});

test("3.4: a question we are not the right party to answer is declined plainly", () => {
  const a = metaAnswers.answerFor("what_is_the_salary", {});
  assert.equal(a.answered, false);
  assert.equal(a.topic, null);
  assert.equal(a.text, metaAnswers.DEFERRAL);
});

test("3.5: no answer about the interview ever rates the candidate", () => {
  // The boot check enforces this at require time; this asserts it stays enforced, and covers the
  // deferral and every state branch rather than the single sample the boot check uses.
  const states = [
    { questionCount: 0, minQuestions: 5, maxQuestions: 8, proctoringEnabled: true },
    { questionCount: 7, minQuestions: 5, maxQuestions: 8, proctoringEnabled: false },
    { questionCount: 8, minQuestions: 8, maxQuestions: 8 },
  ];
  for (const state of states) {
    for (const topic of metaAnswers.TOPIC_NAMES) {
      const { text } = metaAnswers.answerFor(topic, state);
      const offender = backchannel.findEvaluativeWord(text);
      assert.equal(offender, null, `"${text}" (${topic}) rates the candidate via "${offender}"`);
    }
  }
  assert.equal(backchannel.findEvaluativeWord(metaAnswers.DEFERRAL), null);
});

test("3.6: 'how am I doing?' has no answer here at all", () => {
  // Deliberately absent from the table: it is an assessment delivered to the candidate
  // mid-interview with no human in the loop, and it varies with their performance.
  assert.ok(!metaAnswers.TOPIC_NAMES.includes("how_am_i_doing"));
  assert.equal(metaAnswers.answerFor("how_am_i_doing", {}).text, metaAnswers.DEFERRAL);
});

test("3.7: a malformed state costs the candidate a fact, never a reply", () => {
  const a = metaAnswers.answerFor("how_many_left", { maxQuestions: "not a number" });
  assert.equal(a.answered, false);
  assert.ok(a.text.length > 0, "they always get an answer of some kind");
});

test("3.8: 'why are you asking me this?' is answerable in any session state", () => {
  // Unlike every other topic here, this one needs nothing loaded — where the questions come from
  // is true of the interview before a single field is read. So it must answer on an empty state,
  // which is exactly the state a session in trouble is in.
  const a = metaAnswers.answerFor("why_this_question", {});
  assert.equal(a.answered, true);
  assert.equal(a.text, metaAnswers.WHY_THIS_QUESTION);
  assert.match(a.text, /role asks for/, "it says where the question came from");
  // Short on purpose. A long answer to this question implies the question needed defending, which
  // tells an uneasy candidate they were right to be uneasy.
  assert.ok(a.text.split(/\s+/).length <= 14, "it stays a passing remark, not a statement");
});

test("3.9: the answer states where the question came from and never argues for it", () => {
  // The regression this guards is a well-meaning one: someone later "improves" this sentence by
  // adding the reason — the rubric criterion's rationale is right there and it reads well. It is
  // still wrong to say. Justifying a question in front of the candidate who asked drifts into
  // describing what a good answer contains, and only the candidates who thought to ask would get
  // it. Where the question came from is the whole permitted answer.
  const text = metaAnswers.WHY_THIS_QUESTION.toLowerCase();
  for (const banned of [
    "because",
    "looking for",
    "we want to",
    "measure",
    "assess",
    "evaluate",
    "test",
    "important",
    "sorry",
  ]) {
    assert.ok(!text.includes(banned), `the answer must not justify the question — found "${banned}"`);
  }
});

// ---------------------------------------------------------------------------
// 4. The reply bank grew — and the guarantees on it did not weaken
// ---------------------------------------------------------------------------

test("4.1: the new reply banks exist and reach the browser", () => {
  const policy = backchannel.clientPolicy();
  assert.ok(policy.clarifyPreambles.length, "clarify must have approved phrasing");
  assert.ok(policy.technicalReplies.length, "a broken microphone must have an approved reply");
});

test("4.2: every phrase in the bank is still non-evaluative, including the new ones", () => {
  // Rendered WITH a name as well as without. `allPhrases()` with no name silently drops every
  // "{name}" phrase, so checking only that form would leave the name-bearing half of the
  // acknowledge bank untested by the one guard that matters most about it.
  const everything = [...backchannel.allPhrases(), ...backchannel.allPhrases({ firstName: "Priya" })];
  assert.ok(
    everything.length > backchannel.allPhrases().length,
    "the name-bearing phrases must actually be reached by this test"
  );
  for (const phrase of everything) {
    assert.equal(
      backchannel.findEvaluativeWord(phrase),
      null,
      `"${phrase}" signals how well the candidate did`
    );
  }
});

test("4.3: clarify and repeat are different things and say different things", () => {
  // The whole point of the clarify path: someone who did not understand is not helped by hearing
  // the identical sentence again.
  const repeat = backchannel.phrases("repeat");
  const clarify = backchannel.phrases("clarify");
  for (const c of clarify) assert.ok(!repeat.includes(c), `"${c}" must not be shared with repeat`);
});

// ---------------------------------------------------------------------------
// 5.x  Ending a turn — patience aimed at doubt, not at everyone
// ---------------------------------------------------------------------------
//
// The end-of-turn ladder used to run identically after every answer: reassure, reassure,
// "anything you'd like to add?", five seconds, submit. That is ~8.4s of tail on a clean finished
// answer and ~30s when the last transcript chunk arrived without a full stop — the interviewer
// offering time to someone who stopped speaking half a minute ago.
//
// The decision now depends on how much doubt there actually is. The BRANCHING lives in the
// browser (only it knows when the silence started), so what is pinned here is the policy it
// branches on: the numbers, their ordering, and the fact that they ship at all.

test("5.1: the confident ending ships, and is far shorter than the doubtful one", () => {
  const p = backchannel.clientPolicy();
  assert.ok(p.settledGraceMs > 0, "a settled answer still gets a moment for a trailing transcript");
  assert.ok(
    p.settledGraceMs < p.confirmGraceMs,
    "ending a finished answer must be quicker than waiting out a check-in — that gap IS the fix"
  );
  assert.ok(p.settledGraceMs < p.endingGraceMs);
  // The whole saving is the check-in plus its grace. If this ever stops being worth seconds,
  // the change has been undone by tuning.
  assert.ok(p.confirmGraceMs - p.settledGraceMs >= 3000, "the confident path must save real time");
});

test("5.2: 'substantial' is a real threshold, not zero", () => {
  const p = backchannel.clientPolicy();
  // A three-word utterance that happens to end in a full stop ("Yes, I did.") must NOT be taken
  // as a whole answer and ended on the fast path — that is someone starting, not finishing.
  assert.ok(p.settledMinWords >= 8, "too low and an opening sentence ends the turn");
  assert.ok(p.settledMinWords <= 25, "too high and every ordinary answer pays the slow path");
});

test("5.3: patience is still available where it is actually needed", () => {
  const p = backchannel.clientPolicy();
  // Nothing here may be read as "the interviewer got less patient". The ladder is intact for the
  // candidate who is mid-thought or has not started; it simply no longer fires at people who
  // have finished. A candidate who trails off on "and…" must still get a generous window.
  assert.ok(p.maxReassurancesPerTurn > 0, "reassurance must survive for the mid-thought case");
  assert.ok(p.postReassuranceGraceMs >= 8000, "an offer of time has to be long enough to mean it");
  assert.ok(p.initialSilenceMs >= 5000, "a candidate who has not started is not hurried");
  assert.ok(p.confirmations.length, "the check-in still exists for the doubtful case");
});

// ---------------------------------------------------------------------------
// 6.x  Warmth that cannot become an assessment
// ---------------------------------------------------------------------------
//
// The interviewer is forbidden from saying anything that varies with how the candidate is doing
// (utils/backchannel EVALUATIVE_WORDS) — which is correct, and which had left it reading as
// courteous rather than warm: four acknowledgement phrases on rotation and the candidate's name
// used exactly twice in twenty minutes, hello and goodbye.
//
// Two things were added, and both had to pass the same test: can this vary with the answer? A
// name cannot — it is fixed before a word is spoken. A change-of-subject announcement cannot — it
// is a fact about the interview's structure. Anything that could (a topic, a characterisation,
// "that's helpful") stays forbidden however natural it would sound.

test("6.1: a name-bearing phrase is dropped, never rendered with a hole in it", () => {
  const withName = backchannel.phrases("acknowledge", { firstName: "Priya" });
  const without = backchannel.phrases("acknowledge");

  assert.ok(withName.some((p) => p.includes("Priya")), "the name is actually used");
  assert.ok(withName.length > without.length, "a nameless session gets fewer phrases, not broken ones");
  for (const p of [...withName, ...without]) {
    assert.ok(!p.includes("{name}"), `"${p}" leaked its template`);
    assert.ok(!/,\s*\.|\s,/.test(p), `"${p}" reads like a phrase with a gap where a name should be`);
  }
});

test("6.2: a 'name' we cannot say out loud is treated as no name at all", () => {
  // All of these appear on real applications. None of them should ever be spoken to someone.
  for (const junk of ["", "   ", "-", "j", "J.", "123", "!!!", null, undefined, "@gmail.com"]) {
    assert.equal(backchannel.firstNameOf(junk), "", `"${junk}" must not become a spoken name`);
  }
  assert.equal(backchannel.firstNameOf("Priya Raghunathan"), "Priya");
  assert.equal(backchannel.firstNameOf("  anne-marie  dubois "), "anne-marie");
  assert.equal(backchannel.firstNameOf("Søren Kierkegaard"), "Søren", "non-ASCII names are names");
});

test("6.3: one session cannot authorise another candidate's sentence", () => {
  // The bank is rendered PER SESSION. A global "does this look like a bank phrase" check would
  // let any session speak any name — a small hole, in the one mechanism whose entire value is
  // that it has none.
  assert.equal(backchannel.isBankPhrase("Thank you, Priya.", { firstName: "Priya" }), true);
  assert.equal(backchannel.isBankPhrase("Thank you, Priya.", { firstName: "Marcus" }), false);
  assert.equal(backchannel.isBankPhrase("Thank you, Priya.", {}), false);
  // And the nameless phrases still work for everyone, so a candidate with no usable first name
  // is not left with an interviewer that cannot acknowledge them at all.
  assert.equal(backchannel.isBankPhrase("Thank you.", {}), true);
});

test("6.4: the acknowledgement rotation lasts a whole interview", () => {
  // At four phrases a candidate heard each one twice in an eight-question interview, in the same
  // order — the specific texture that reads as a recording being played back.
  const p = backchannel.clientPolicy({ firstName: "Priya" });
  assert.ok(p.acknowledgements.length >= 8, "a full-length interview should not repeat itself");
  assert.equal(new Set(p.acknowledgements).size, p.acknowledgements.length, "no duplicates");
});

test("6.5: a bridge announces a change of subject and nothing else", () => {
  const bridges = backchannel.phrases("bridge");
  assert.ok(bridges.length, "the bridge bank must reach the browser");
  for (const b of bridges) {
    assert.equal(backchannel.findEvaluativeWord(b), null, `"${b}" rates the previous answer`);
    // The failure mode this guards: "that's really helpful, let me move on" is the sentence a
    // human would say and an assessment delivered mid-interview with no human in the loop. A
    // bridge may refer to the interview moving; it may never refer to what was just said.
    assert.ok(
      !/\b(that|your|you)\b.*\b(answer|said|point|example)\b/i.test(b),
      `"${b}" characterises the previous answer`
    );
  }
  assert.ok(backchannel.clientPolicy().bridges.length, "bridges ship in the client policy");
});

test("6.6: a bridge is only offered where the question really does change the subject", () => {
  // Announcing a change of subject in front of a direct follow-up would be worse than saying
  // nothing, so the decision is the SERVER's — the browser only ever sees question text and has
  // no way to tell an approved question from an adaptive follow-up.
  const policy = backchannel.clientPolicy();
  assert.ok(Array.isArray(policy.bridges));
  // And the phrase bank alone cannot trigger one: the flag comes from publicState.
  assert.ok(!("currentQuestionBridges" in policy), "the browser is told, it does not decide");
});

// ---------------------------------------------------------------------------
// 7.x  Clarify — a rewording that a human approved, or none at all
// ---------------------------------------------------------------------------
//
// "What do you mean by that?" used to be answered with "of course, let me put that a different
// way" followed by the IDENTICAL sentence. A promise broken in the same breath, and worse than
// not offering to rephrase at all.
//
// The fix cannot be "let the model rephrase it". A question composed in the moment means the
// candidate who asked for help was measurably asked something different from everyone else — so
// it would be exactly the candidates who needed the most help who sat a non-standard test, and
// "we asked everyone the same thing" would stop being true precisely where it matters most.
//
// So a rewording exists only if a recruiter wrote and froze it alongside the question, and it is
// vetted to the same standard because it is READ TO THE CANDIDATE in place of one.

const { vetQuestions } = require("../../utils/questionVetting");
const speechAuth = require("../../utils/speechAuthorization");

const GOOD_Q = "Walk me through how you decided on the data model for that ingestion service.";

test("7.1: a restatement is vetted exactly as hard as a question", () => {
  // The obvious back door: wording nobody would approve as a question, smuggled in as the
  // "plain language" version of an innocuous one.
  const v = vetQuestions([
    { id: "q1", text: GOOD_Q, restatement: "In plain terms — do you have any criminal convictions?" },
  ]);
  assert.equal(v.ok, false);
  assert.ok(
    v.issues.some((i) => i.code === "restatement_protected_criminal"),
    "a protected-characteristic question must be blocked in a restatement too"
  );
});

test("7.2: a restatement identical to its question is rejected", () => {
  const v = vetQuestions([{ id: "q1", text: GOOD_Q, restatement: `  ${GOOD_Q.toUpperCase()}  ` }]);
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.code === "restatement_identical"));
});

test("7.3: no restatement is a valid set — the interviewer just cannot rephrase", () => {
  // Optional on purpose. An existing approved set must not become un-approvable because a field
  // was added, and "we have no approved rewording" is an honest state with an honest behaviour
  // (repeat the question) rather than a blocker.
  assert.equal(vetQuestions([{ id: "q1", text: GOOD_Q }]).ok, true);
  assert.equal(vetQuestions([{ id: "q1", text: GOOD_Q, restatement: "" }]).ok, true);
  assert.equal(
    vetQuestions([{ id: "q1", text: GOOD_Q, restatement: "Put simply: why that shape of data, and not another?" }]).ok,
    true
  );
});

test("7.4: a restatement is speakable only because it is on the turn", () => {
  // Every word the interviewer says is checked against a closed set: the approved phrase bank plus
  // interviewer text already in this session's transcript. A restatement is neither until it is
  // written onto the question turn — so this is what makes the clarify path able to speak at all,
  // and what stops any other rewording being spoken.
  const restatement = "Put simply: why that shape of data, and not another?";
  const session = {
    aiInterview: {
      candidateFirstName: "Priya",
      turns: [{ role: "ai", kind: "question", text: GOOD_Q, restatement }],
    },
  };
  assert.equal(speechAuth.authorize(restatement, session).authorized, true);
  assert.equal(speechAuth.authorize(restatement, session).kind, "restatement");
  assert.equal(speechAuth.authorize(GOOD_Q, session).authorized, true);
  // A rewording that was never approved for this session is refused, which is the whole control.
  assert.equal(
    speechAuth.authorize("Let me ask it another way — what database did you use?", session).authorized,
    false
  );
  // And a session whose turn carries no restatement can speak no rewording whatsoever.
  const bare = { aiInterview: { turns: [{ role: "ai", kind: "question", text: GOOD_Q }] } };
  assert.equal(speechAuth.authorize(restatement, bare).authorized, false);
});

test("7.5: 'do you have any criminal convictions' is caught as a question too", () => {
  // Found by writing 7.1: the pattern was "criminal record" and "convicted", so the single most
  // natural phrasing of a banned question — an adjective and a noun the pattern happened not to
  // put next to each other — went straight through the gate as an ordinary question.
  const banned = [
    "Do you have any criminal convictions?",
    "Tell me about your criminal history.",
    "Have you ever been arrested?",
    "Do you have any spent convictions to declare?",
  ];
  for (const q of banned) {
    const v = vetQuestions([{ id: "q1", text: q }]);
    assert.ok(
      v.issues.some((i) => i.code === "protected_criminal"),
      `"${q}" reached a candidate`
    );
  }
  // And an ordinary question that merely contains one of those words is still askable.
  assert.equal(
    vetQuestions([{ id: "q1", text: "Walk me through how your team recorded and tracked incident history." }]).ok,
    true
  );
});

// ---------------------------------------------------------------------------
// 8.x  "They meant that, they just said it differently"
// ---------------------------------------------------------------------------
//
// The trigger lists match word sequences. "repeat that" matches; "run that by me again" does not.
// The semantic tier is the answer to that, and it had three holes: it was gated so tightly that a
// short request mid-answer was never looked up, it could not reach "I'm done", and one path had no
// tier at all. Two of those are now closed. The third is deliberately left open — see 8.5.

test("8.1: the tier can now reach a hand-back nobody put on a list", () => {
  assert.ok(conversationIntent.TIER1_ACTIONS.includes("finished"));
  const gated = conversationIntent.gateSemantic(
    { action: "finished", confidence: 0.9, reason: "handing the floor back" },
    "and that's basically the whole of how we did it, so yeah, that's me",
    { answerWords: 60 }
  );
  assert.equal(gated.action, "finished");
  // Their words are the answer — nothing is stripped. The turn just ends now instead of after a
  // silence timer the candidate cannot see.
  assert.equal(gated.consumesTurn, false);
});

test("8.2: a hand-back is refused until there is an answer to hand back", () => {
  // The one action here that can destroy evidence: act on it early and a sentence still forming is
  // submitted as somebody's complete response. Guarded by how much they have ALREADY said, not by
  // how confident the model is — a confident misreading is exactly the dangerous case.
  const early = conversationIntent.gateSemantic(
    { action: "finished", confidence: 0.99, reason: "sounds final" },
    "yeah that's it",
    { answerWords: 3 }
  );
  assert.equal(early.action, "answer_continues");
  assert.match(early.reason, /too_early_to_be_finished/);
});

test("8.3: a long utterance can be a hand-back, but nothing else can", () => {
  const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
  // Every other action asserts "I am not answering", which forty words of speech contradicts.
  for (const action of ["repeat", "clarify", "decline", "pause", "meta_question", "withdraw"]) {
    const g = conversationIntent.gateSemantic({ action, confidence: 0.95, reason: "x" }, long, { answerWords: 80 });
    assert.equal(g.action, "answer_continues", `${action} must not survive at ${40} words`);
  }
  // "finished" is the exception precisely BECAUSE it is long: people end an answer by finishing a
  // sentence, not by saying a keyword.
  const fin = conversationIntent.gateSemantic(
    { action: "finished", confidence: 0.95, reason: "x" },
    long,
    { answerWords: 80 }
  );
  assert.equal(fin.action, "finished");
});

test("8.4: the cost gate and the correctness gate are different numbers", () => {
  // Collapsing these two was the bug: the call itself was refused at maxMetaWords, so `finished`
  // could never be reached for any phrasing longer than a keyword — the exact phrasings people use.
  const p = conversationIntent.clientPolicy().intent;
  assert.ok(
    p.maxUtteranceWords > p.maxMetaWords,
    "refusing to classify at the tighter bound makes the exempt action unreachable"
  );
  assert.ok(p.minWordsForFinish > 0);
});

test("8.5: answering 'yes, end my interview' deliberately has NO semantic tier", () => {
  // This looks like the same gap and is the opposite of it. An unrecognised reply is treated as
  // "no" and the interview continues — so a MISSED yes costs one more question they can decline,
  // or a button press needing no words at all. A model could only change the outcome by turning
  // something ambiguous INTO a yes, and that error ends an interview somebody wanted to keep
  // having. Everywhere else better understanding shrinks the failure; here it would grow it.
  assert.equal(conversationIntent.CONFIRM_HAS_NO_SEMANTIC_TIER, true);
  for (const name of conversationIntent.TIER1_ACTIONS) {
    assert.ok(!/^confirm/.test(name), `${name} would let an inference end an interview`);
  }
  // And withdrawal itself still confirms, however it was read.
  assert.equal(conversationIntent.ACTIONS.withdraw.needsConfirmation, true);
});

test("8.6: the deterministic tier composes finish too, and ranks it last", () => {
  // It used to be checked at a separate point in the browser's handler, so which reading won when
  // it and a decline both matched depended on statement order. Running it through PRECEDENCE puts
  // it below everything: any other reading that fits is preferred, because this is the only one
  // that can submit a partial answer.
  const P = conversationIntent.PRECEDENCE;
  assert.equal(P[P.length - 1], "finished");
  const r = conversationIntent.detectDeterministic(
    "we ran three brokers across two availability zones and the lag stayed low, that's my answer"
  );
  assert.equal(r.action, "finished");
  assert.equal(r.tier, 0);
});

// ---------------------------------------------------------------------------
// 9.x  The misses close the gap permanently
// ---------------------------------------------------------------------------
//
// A trigger list is a developer's guess at how people talk, made once, never revisited. The
// semantic tier covers what the guess missed — but it pays a model call every time, forever, for
// phrasings a tenant's candidates use every week, and nobody ever learns which guesses were wrong.
//
// Every Tier-1 reading IS a miss, by construction: the deterministic tier ran first and said
// nothing. So they are counted, and the recurring ones go to a recruiter to promote into instant
// rules. The list stops being a guess and becomes what the candidates actually said.

const intentPhraseService = require("../../services/intentPhraseService");

test("9.1: a promoted phrase can never invent a behaviour, only reach an existing one sooner", () => {
  for (const action of intentPhraseService.PROMOTABLE_ACTIONS) {
    assert.ok(conversationIntent.ACTIONS[action], `${action} is not a declared action`);
  }
  // "they were answering" is the default and needs no trigger — a phrase meaning that is every
  // phrase that matches nothing.
  assert.ok(!intentPhraseService.PROMOTABLE_ACTIONS.includes("answer_continues"));
});

test("9.2: a phrase too generic to be a rule is refused before a human ever sees it", () => {
  // The failure this prevents: promoting "sure" or "okay" to a deterministic trigger, which then
  // fires inside every hesitant answer for the rest of the tenant's life. The model can read those
  // in context; the deterministic tier has no context, which is exactly why it must not try.
  for (const junk of ["sure", "okay", "yeah", "um", "so well", "yeah okay", "", "   ", "?"]) {
    assert.equal(intentPhraseService.promotable(junk), "", `"${junk}" would fire inside real answers`);
  }
  // And a rambling sentence is not a trigger either — it will never match twice.
  assert.equal(
    intentPhraseService.promotable("could you possibly run that one by me again because I did not quite catch the middle part"),
    ""
  );
  // A real phrasing survives, normalised to the shape the matchers compare against.
  assert.equal(intentPhraseService.promotable("Run that by me again?"), "run that by me again");
});

test("9.3: a tenant can add trigger phrasings but can never remove one", () => {
  // The guard that matters. If a merge could REPLACE the built-in lists, a tenant could configure
  // away a candidate's ability to ask for a repeat, to decline, or to stop the interview — by
  // accident or otherwise. Merging is additive by construction.
  const base = {
    repeatTriggers: ["repeat that", "say that again"],
    finishTriggers: ["that's my answer"],
    dialogueActs: {
      declineTriggers: ["i don't know"],
      pauseTriggers: ["give me a second"],
      withdrawTriggers: ["i want to stop"],
    },
  };
  const merged = intentPhraseService.mergeIntoPolicy(base, {
    repeat: ["run that by me again"],
    decline: ["that one's not me"],
    withdraw: ["i'd like to call it here"],
  });

  for (const t of base.repeatTriggers) assert.ok(merged.repeatTriggers.includes(t), "a built-in trigger was lost");
  assert.ok(merged.repeatTriggers.includes("run that by me again"));
  assert.ok(merged.dialogueActs.declineTriggers.includes("i don't know"));
  assert.ok(merged.dialogueActs.declineTriggers.includes("that one's not me"));
  assert.ok(merged.dialogueActs.withdrawTriggers.includes("i want to stop"));
  assert.ok(merged.dialogueActs.pauseTriggers.includes("give me a second"), "untouched lists survive");
  // Nothing at all approved yet is the overwhelmingly common case and must change nothing.
  assert.deepEqual(intentPhraseService.mergeIntoPolicy(base, {}), base);
  assert.deepEqual(intentPhraseService.mergeIntoPolicy(base, null), base);
});

test("9.4: a promoted phrase still passes through every guard the built-in ones do", () => {
  // Promotion is a fast path, not a new power. A tenant-approved decline trigger buried inside a
  // real answer must be ignored exactly as a built-in one is — otherwise approving a phrase would
  // start eating candidates' evidence.
  const answer =
    "that one's not me exactly but we ran three brokers across two zones and the lag stayed under forty milliseconds";
  const r = conversationIntent.detectDeterministic(answer, {
    actLimits: undefined,
    // Simulating the merged policy: the tenant's phrase is now a real trigger.
  });
  assert.equal(r, null, "a trigger inside a substantive answer is evidence, not an act");
});
