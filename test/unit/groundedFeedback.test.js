// The interviewer responding to what the candidate actually said — without ever rating it.
//
// This suite exists because the feature it covers was requested in a form that would have broken
// the product. The ask was for the interviewer to say "Yes, that's correct", "you're on the right
// track", "it sounds like you have practical experience with it", and — for a wrong answer — "I
// understand. Thank you for explaining your approach."
//
// Those are not four phrasings of one feature. They are two features wearing one coat:
//
//   GROUNDING  — naming something the candidate said. Verifiable, identical in kind for every
//                candidate, and the entire reason the interview stops sounding like a form.
//   RATING     — signalling how the answer went. An assessment delivered to a candidate with no
//                human in the loop, whose DIFFERENTIAL is itself the score: a candidate who gets
//                "that's correct" on Q2 and "thank you for explaining your approach" on Q3 has
//                been told they failed Q3, and answers Q4 onward as someone who believes they are
//                failing. The instrument then measured something different for them than for the
//                candidate who opened strong, so the two scores are not comparable — which is the
//                whole premise of a structured interview.
//
// So grounding shipped and rating did not, and the tests below are the fence between them. Every
// literal phrase from the original request appears here as a case that must be REFUSED, because
// "we decided not to do that" is worth nothing without a test that fails when someone does it.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const groundedAck = require("../../utils/groundedAck");
const followUpPrompts = require("../../utils/followUpPrompts");
const closingQuestions = require("../../utils/closingQuestions");
const namePronunciation = require("../../utils/namePronunciation");
const backchannel = require("../../utils/backchannel");
const speechAuthorization = require("../../utils/speechAuthorization");
const questionVetting = require("../../utils/questionVetting");

const ANSWER =
  "Yes, I used Node.js to build an AI recruitment platform. It handled about two thousand " +
  "applications a day and we put the resume parsing behind a queue.";

function ack(leadIn, term = "AI recruitment platform", answer = ANSWER) {
  return groundedAck.decide({ leadIn, term }, answer, { index: 0, firstName: "Vijendra" });
}

// ---------------------------------------------------------------------------
// 1. Grounding is allowed
// ---------------------------------------------------------------------------

test("1.1: a lead-in that names what the candidate said is spoken", () => {
  const r = ack("You mentioned the AI recruitment platform.");
  assert.equal(r.grounded, true, `should have been spoken: ${JSON.stringify(r)}`);
  assert.equal(r.text, "You mentioned the AI recruitment platform.");
  assert.equal(r.term, "AI recruitment platform");
  assert.equal(r.rejection, null);
});

test("1.2: grounding does not require the words 'you mentioned' — only the candidate's own term", () => {
  const r = ack("So that was on the AI recruitment platform.");
  assert.equal(r.grounded, true, `natural phrasing must survive: ${JSON.stringify(r)}`);
});

// ---------------------------------------------------------------------------
// 2. Rating is refused — every phrase from the original request
// ---------------------------------------------------------------------------
//
// Each case is a real sentence someone asked for. The assertion is not that we produce something
// better, it is that we produce the UNIFORM BANK PHRASE instead, which says nothing at all.

const RATING_CASES = [
  ["Yes, that's correct. You mentioned the AI recruitment platform.", "a correctness verdict"],
  ["Yes, you're on the right track with the AI recruitment platform.", "a partial-correctness verdict"],
  ["It sounds like you have practical experience with the AI recruitment platform.", "a conclusion about the candidate"],
  ["The way you explained the AI recruitment platform suggests you've worked with it.", "a judgement of the explaining"],
  ["That makes sense — the AI recruitment platform.", "agreement, which is assessment"],
  ["You clearly know the AI recruitment platform well.", "a competence attribution"],
  ["Not quite, but you mentioned the AI recruitment platform.", "a negative verdict"],
  ["Good answer on the AI recruitment platform.", "praise"],
  ["That's a solid grasp of the AI recruitment platform.", "praise via a synonym"],
  ["Thanks for explaining your approach to the AI recruitment platform.", "the wrong-answer tell"],
];

for (const [phrase, why] of RATING_CASES) {
  test(`2.x: refused — ${why}: "${phrase}"`, () => {
    const r = ack(phrase);
    assert.equal(r.grounded, false, `must NOT be spoken (${why}): ${JSON.stringify(r)}`);
    assert.ok(r.rejection, "the reason must be recorded, not silently dropped");
    assert.ok(
      backchannel.allPhrases({ firstName: "Vijendra" }).includes(r.text),
      `the fallback must be an approved bank phrase, got: ${r.text}`
    );
  });
}

test("2.y: 'thanks for explaining your approach' is the tell that makes rating self-defeating", () => {
  // The spec proposed this as the response to an INCORRECT answer. Within one hiring cycle
  // candidates learn that this exact sentence means "you got it wrong" — at which point it is a
  // covert score disclosure that is both demoralising and gameable, and strictly worse than the
  // uniform phrase. It is refused for the same reason the praise is.
  const r = ack("I understand. Thank you for explaining your approach to the AI recruitment platform.");
  assert.equal(r.grounded, false);
});

// ---------------------------------------------------------------------------
// 3. Cite or abstain — pointed at our own mouth
// ---------------------------------------------------------------------------

test("3.1: the interviewer may not attribute a word the candidate never said", () => {
  const r = ack("You mentioned Kubernetes.", "Kubernetes");
  assert.equal(r.grounded, false, "an ungrounded attribution must never be spoken");
  assert.equal(r.rejection, "term_not_in_answer");
});

test("3.2: a term claimed but absent from the lead-in grounds nothing", () => {
  // The audit trail would claim a grounded acknowledgement while the candidate heard a generic one.
  // Phrased to clear every earlier guard so this isolates the grounding check itself: "thanks for
  // talking me through that" would be refused too, but as manner-praise, which is a different bug.
  const r = ack("So, moving on then.");
  assert.equal(r.rejection, "term_absent_from_lead_in");
});

test("3.3: generic terms are not evidence of listening", () => {
  for (const term of ["it", "the project", "experience", "work"]) {
    const r = ack(`You mentioned ${term}.`, term, `I worked on ${term} for a while.`);
    assert.equal(r.grounded, false, `"${term}" must not count as grounding`);
  }
});

test("3.4: a lead-in must not ask anything — the authored question follows it", () => {
  const r = ack("You mentioned the AI recruitment platform. What did you build?");
  assert.equal(r.rejection, "contains_question");
});

test("3.5: protected characteristics are refused even when the candidate raised them", () => {
  const answer = "I took a career break for my children, then built the AI recruitment platform.";
  const r = ack("You mentioned your children.", "children", answer);
  assert.equal(r.grounded, false);
  assert.equal(r.rejection, "protected_characteristic");
});

test("3.6: abstaining always yields a speakable phrase, never an empty string or a hole", () => {
  for (const proposal of [null, {}, { leadIn: "", term: "" }, { leadIn: "x".repeat(400), term: "q" }]) {
    const r = groundedAck.decide(proposal, ANSWER, { index: 3, firstName: "" });
    assert.ok(r.text && r.text.trim().length > 0, `must stay speakable: ${JSON.stringify(r)}`);
    assert.equal(r.grounded, false);
  }
});

test("3.7: a nameless session never renders a phrase with a gap in it", () => {
  const r = groundedAck.decide(null, ANSWER, { index: 2, firstName: "" });
  assert.ok(!r.text.includes("{name}"), `unrendered placeholder leaked: ${r.text}`);
  assert.ok(!/,\s*\./.test(r.text), `empty-name artefact leaked: ${r.text}`);
});

// ---------------------------------------------------------------------------
// 4. Follow-ups: adaptive, JD-aware, and never a hint
// ---------------------------------------------------------------------------

function followUp(text, term = "Node.js", answer = ANSWER, opts = { followUpsRemaining: 4 }) {
  return followUpPrompts.decideFollowUp(
    { followUpWorthwhile: true, followUp: text, term, followUpRationale: "establish ownership" },
    answer,
    opts
  );
}

test("4.1: a grounded follow-up about what they said is asked", () => {
  const r = followUp("You mentioned Node.js — what did it actually do in that platform?");
  assert.equal(r.ask, true, `should be asked: ${JSON.stringify(r)}`);
  assert.equal(r.rationale, "establish ownership", "the reviewer's reason is carried, never spoken");
});

test("4.2: 'tell me about' / 'walk me through' are questions, whatever the punctuation", () => {
  // utils/questionSetPrompts explicitly asks recruiter question sets to use these openers, so an
  // adaptive follow-up that used one must not be refused for lacking a question mark.
  for (const q of [
    "Tell me about Node.js in that platform.",
    "Walk me through what Node.js was doing there.",
  ]) {
    assert.equal(followUp(q).ask, true, `must be accepted: ${q}`);
  }
});

test("4.3: a leading question that carries its own answer is refused", () => {
  const r = followUp("Did you use Node.js because it handles concurrency well?");
  assert.equal(r.ask, false);
  assert.equal(r.rejection, "leading");
});

test("4.4: two questions in one breath are refused", () => {
  // The candidate answers the second and the first is recorded as unanswered.
  for (const q of [
    "What did Node.js do there, and how did you test it?",
    "What did Node.js do there? How did you test it?",
  ]) {
    const r = followUp(q);
    assert.equal(r.ask, false, `must be refused: ${q}`);
    assert.equal(r.rejection, "multiple_questions");
  }
});

test("4.5: a follow-up may not rate the answer either", () => {
  const r = followUp("What was weak about the Node.js side?");
  assert.equal(r.ask, false);
  assert.match(r.rejection, /^evaluative:/);
});

test("4.6: a follow-up must be anchored in the candidate's own words", () => {
  const r = followUp("How did you configure Kubernetes?", "Kubernetes");
  assert.equal(r.ask, false);
  assert.ok(["anchor_not_in_answer", "anchor_absent_from_follow_up"].includes(r.rejection), r.rejection);
});

test("4.7: follow-ups are capped, so the approved instrument always dominates", () => {
  const r = followUp("Tell me about Node.js there.", "Node.js", ANSWER, { followUpsRemaining: 0 });
  assert.equal(r.ask, false);
  assert.equal(r.rejection, "cap_reached");
});

test("4.8: a thin answer gets no follow-up — there is nothing to pursue, and pressing is not a question", () => {
  const r = followUp("Tell me about Node.js there.", "Node.js", "Yes, I have.", { followUpsRemaining: 4 });
  assert.equal(r.ask, false);
  assert.equal(r.rejection, "answer_too_short");
});

test("4.9: a follow-up passes the same vetting a recruiter's own question would", () => {
  const r = followUp("How old were you when you built the Node.js part?");
  assert.equal(r.ask, false, "protected-attribute questions must never reach a candidate");
});

test("4.10: every refusal names a reason, so a silent regression is impossible", () => {
  const r = followUp("Did you use Node.js because it is fast?");
  assert.ok(r.rejection && typeof r.rejection === "string" && r.rejection.length > 0);
});

// ---------------------------------------------------------------------------
// 5. The interviewer is not assumed to be technical
// ---------------------------------------------------------------------------

test("5.1: the question prompt takes its domain from the job, not from the word 'technical'", () => {
  const marketing = followUpPrompts.interviewerSystemFor({ title: "Performance Marketing Manager" });
  assert.ok(!/technical interviewer/i.test(marketing), `must not assert a technical domain: ${marketing}`);
  assert.match(marketing, /Performance Marketing Manager/, "the role is named");
  assert.match(marketing, /never assume it is a software role/i, "the assumption is explicitly blocked");
});

test("5.2: a missing job title still produces a usable interviewer", () => {
  const s = followUpPrompts.interviewerSystemFor({});
  assert.ok(!/undefined|null/.test(s), s);
});

// ---------------------------------------------------------------------------
// 6. The closing sequence
// ---------------------------------------------------------------------------

test("6.1: the capstone comes before the closers, and its follow-up comes after it", () => {
  const kinds = closingQuestions.closingSequence({ seed: 3 }).map((q) => q.kind);
  assert.deepEqual(kinds.slice(0, 2), ["capstone", "capstone_follow"]);
  assert.ok(kinds.slice(2).every((k) => k === "closer"));
});

test("6.2: the capstone is asked in two turns, not as three questions in one breath", () => {
  assert.ok(!closingQuestions.CAPSTONE_PRIMARY.includes("role was"), "the role question is its own turn");
  assert.equal((closingQuestions.CAPSTONE_PRIMARY.match(/\?/g) || []).length, 1);
});

test("6.3: closer selection is deterministic — replaying a session asks the same questions", () => {
  assert.deepEqual(closingQuestions.closersFor(11), closingQuestions.closersFor(11));
  assert.notDeepEqual(closingQuestions.closersFor(0), closingQuestions.closersFor(1));
});

test("6.4: closers are marked easy by design, so a reviewer knows it was the script", () => {
  for (const q of closingQuestions.closingSequence({ seed: 0 }).filter((x) => x.kind === "closer")) {
    assert.equal(q.difficulty, "easy");
  }
});

test("6.5: every closing question is askable and about WORK, never about the candidate's life", () => {
  for (const q of [closingQuestions.CAPSTONE_PRIMARY, closingQuestions.CAPSTONE_FOLLOW, ...closingQuestions.CLOSERS]) {
    assert.deepEqual(questionVetting.questionIssues(q), [], `must pass vetting: ${q}`);
    assert.deepEqual(
      questionVetting.protectedAttributeIssues(q),
      [],
      `a closer must never touch a protected characteristic: ${q}`
    );
    // "What do you do for fun?" is the version of this that drifts into family, faith and health.
    assert.ok(!/\b(?:fun|hobb|weekend|family|home life)\b/i.test(q), `must stay about work: ${q}`);
  }
});

// ---------------------------------------------------------------------------
// 7. Saying the candidate's name
// ---------------------------------------------------------------------------

test("7.1: an explicit respelling the candidate volunteers is adopted", () => {
  const r = namePronunciation.fromSelfReport("It's vih-JEN-dra.", "Vijendra");
  assert.equal(r.source, "explicit");
  assert.equal(r.respelling, "vih-JEN-dra");
});

test("7.2: the transcriber's own spelling counts when it is plausibly the same name", () => {
  const r = namePronunciation.fromSelfReport("Yeah sure, my name is Bijendra.", "Vijendra");
  assert.equal(r.source, "asr");
});

test("7.3: romanisation differences survive — the whole point of asking", () => {
  assert.ok(namePronunciation.fromSelfReport("shao-ling", "Xiaoling"), "sh/x must be treated as one sound");
});

test("7.4: a different name is refused rather than put in the interviewer's mouth", () => {
  assert.equal(namePronunciation.fromSelfReport("It's Michael.", "Vijendra"), null);
});

test("7.5: a candidate who answered a different question does not get a mangled name", () => {
  for (const t of ["I work as a backend engineer at Infosys.", "Sorry, I couldn't hear you.", ""]) {
    assert.equal(namePronunciation.fromSelfReport(t, "Vijendra"), null, `must abstain on: ${t}`);
  }
});

test("7.6: with no verified respelling the name is spoken exactly as written — no regression", () => {
  const out = namePronunciation.applyTo("Hi Vijendra — welcome.", "Vijendra", "");
  assert.equal(out.applied, false);
  assert.equal(out.text, "Hi Vijendra — welcome.");
});

test("7.7: the respelling replaces the name wherever it is spoken", () => {
  const out = namePronunciation.applyTo("Thanks, Vijendra — I've got that down.", "Vijendra", "vih-JEN-dra");
  assert.equal(out.applied, true);
  assert.match(out.text, /vih-JEN-dra/);
  assert.ok(!/Vijendra/.test(out.text));
});

test("7.8: the candidate is never asked to repeat their own name more than twice", () => {
  assert.ok(namePronunciation.MAX_ATTEMPTS <= 2, "asking a third time is a machine failing, not a candidate");
});

// ---------------------------------------------------------------------------
// 8. The spoken word is still authorised
// ---------------------------------------------------------------------------
//
// A grounded acknowledgement is stored on the CANDIDATE's answer turn, not as an interviewer turn,
// so it is deliberately outside the mechanism that authorises interviewer speech. If that boundary
// is not bridged, the feature ships as a sentence the interviewer composes and then cannot say.

test("8.1: a grounded acknowledgement is speakable, and recognised as its own kind", () => {
  const session = {
    aiInterview: {
      candidateFirstName: "Vijendra",
      turns: [
        { role: "ai", kind: "question", text: "Have you worked with Node?" },
        { role: "candidate", kind: "answer", text: ANSWER, ack: { text: "You mentioned the AI recruitment platform.", grounded: true } },
      ],
    },
  };
  const verdict = speechAuthorization.authorize("You mentioned the AI recruitment platform.", session);
  assert.equal(verdict.authorized, true, `the engine must be able to say what it authored: ${JSON.stringify(verdict)}`);
  assert.equal(verdict.kind, "grounded_ack", "distinguishable from a question in the audit record");
});

test("8.2: an acknowledgement from another session is still not speakable here", () => {
  const session = { aiInterview: { candidateFirstName: "Vijendra", turns: [] } };
  assert.equal(speechAuthorization.authorize("You mentioned the AI recruitment platform.", session).authorized, false);
});

// ---------------------------------------------------------------------------
// 9. The guarantee holds by construction, not by this test file
// ---------------------------------------------------------------------------

test("9.1: groundedAck and the follow-up gate share ONE definition of evaluative language", () => {
  // Two lists would drift, and the drift would be invisible: a word removed from one would keep
  // passing the other's tests. Both paths call backchannel.findEvaluativeWord.
  const word = backchannel.EVALUATIVE_WORDS[0];
  const a = ack(`You mentioned the AI recruitment platform, ${word} work.`);
  const b = followUp(`You mentioned Node.js — was the ${word} part hard?`);
  assert.equal(a.grounded, false);
  assert.equal(b.ask, false);
});

test("9.2: no phrase this feature can speak would fail the bank's own boot check", () => {
  // The bank throws at require time on evaluative language (utils/backchannel.js). A grounded
  // acknowledgement is not in the bank, so nothing checks it at boot — this is that check.
  const spoken = ack("You mentioned the AI recruitment platform.");
  assert.equal(backchannel.findEvaluativeWord(spoken.text), null);
});

// ---------------------------------------------------------------------------
// 10. The interviewer does not speak twice, and does not stay silent about what it cannot see
// ---------------------------------------------------------------------------

test("10.1: a decline gets no grounded acknowledgement — its own approved reply already covers it", () => {
  // Both would be spoken. A candidate who said "I don't know" would hear "That's no problem —
  // let's move on." followed by "Thank you.", the second thanking them for an answer they had just
  // explained they could not give.
  const declined = groundedAck.decide(null, "I don't know.", { index: 0, firstName: "Vijendra" });
  assert.equal(declined.rejection, "no_proposal");
  // The engine-level guard is that reflect() returns rejection "not_an_answer" for a declined turn
  // and advance() refuses to store it; asserted here as the contract that must hold.
  assert.ok(
    ["no_proposal", "not_an_answer"].includes(declined.rejection),
    "a non-answer must never produce a stored acknowledgement"
  );
});

test("10.2: an unavailable camera pipeline is reported, and is weightless", () => {
  const proctoring = require("../../utils/proctoring");
  const counts = { vision_unavailable: 1, tab_switch: 2 };
  const withGap = proctoring.computeRisk(counts);
  const withoutGap = proctoring.computeRisk({ tab_switch: 2 });
  assert.equal(withGap.riskScore, withoutGap.riskScore, "our own blind spot may never score against a candidate");

  const row = proctoring.breakdown(counts).find((r) => r.type === "vision_unavailable");
  assert.ok(row, "the gap must be VISIBLE to the recruiter, not silently absent");
  assert.equal(row.scored, false);
  assert.equal(row.points, 0);
  assert.match(row.benignExplanation, /did not run/i, "the report must say the checks did not run");
});

test("10.3: no camera flags plus no vision is distinguishable from no camera flags plus vision", () => {
  const proctoring = require("../../utils/proctoring");
  const unwatched = proctoring.breakdown({ vision_unavailable: 1 });
  const watchedAndClean = proctoring.breakdown({});
  assert.notDeepEqual(
    unwatched.map((r) => r.type),
    watchedAndClean.map((r) => r.type),
    "an interview nobody watched must not read identically to a clean one"
  );
});

test("10.4: 'how old were you' is caught, not just 'how old are you'", () => {
  // The existing age pattern matched only the present tense, so a past-tense age question passed
  // vetting — for adaptive follow-ups AND for anything a recruiter typed into a question set.
  assert.notDeepEqual(questionVetting.protectedAttributeIssues("How old were you when you led that?"), []);
  assert.notDeepEqual(questionVetting.protectedAttributeIssues("How old are you?"), []);
  // ...without breaking the legitimate question that shares the word.
  assert.deepEqual(questionVetting.protectedAttributeIssues("How did you migrate the old system?"), []);
});

// ---------------------------------------------------------------------------
// 11. Sounding like a person, without becoming a different kind of machine
// ---------------------------------------------------------------------------
//
// The first version of this feature passed every safety test and still sounded automated: it said
// "You mentioned the X." on all eight turns. Safe and robotic is a failure too — candidates read it
// as a recording, which is the exact complaint the feature existed to fix. These are the gates on
// the fix, and the last two are the ones that matter: variety must never become a channel through
// which the model can be warmer to candidates it prefers.

test("11.1: the frame varies across turns instead of repeating one phrasing", () => {
  const shapes = [];
  for (let i = 0; i < 7; i += 1) shapes.push(groundedAck.shapeFor(i).key);
  assert.equal(new Set(shapes).size, shapes.length, `every slot must be distinct, got: ${shapes.join(", ")}`);
  assert.ok(shapes.includes("silent"), "one slot must say nothing — always acknowledging is itself the tell");
});

test("11.2: the rotation is deterministic and reproducible from the turn index alone", () => {
  for (let i = 0; i < 20; i += 1) {
    assert.equal(groundedAck.shapeFor(i).key, groundedAck.shapeFor(i).key);
    assert.equal(groundedAck.shapeFor(i).key, groundedAck.shapeFor(i + groundedAck.SHAPES.length).key);
  }
});

test("11.3: the shape CANNOT depend on the answer — that would be differential warmth", () => {
  // If the model chose the frame, it would choose warmer frames for answers it liked, and warmth
  // that tracks quality is feedback arriving by the one route the word list cannot see. The shape is
  // a function of the turn index and nothing else, so two candidates at question four get the same
  // interviewer.
  const strong = "I rebuilt the whole ingestion pipeline and cut p99 from nine seconds to four hundred ms.";
  const weak = "Um, yeah, I think I used it once maybe on a small thing.";
  for (let i = 0; i < 7; i += 1) {
    assert.equal(
      groundedAck.decide({ leadIn: "x", term: "y" }, strong, { index: i }).shape,
      groundedAck.decide({ leadIn: "x", term: "y" }, weak, { index: i }).shape,
      "the frame must be identical regardless of how the answer went"
    );
  }
});

test("11.4: the silent slot speaks nothing at all, and says why in the record", () => {
  const silentIndex = groundedAck.SHAPES.findIndex((s) => s.key === "silent");
  const r = groundedAck.decide({ leadIn: "You mentioned the queue.", term: "queue" }, ANSWER, { index: silentIndex });
  assert.equal(r.text, "", "a silent turn must not fall back to a bank phrase — that defeats the point");
  assert.equal(r.rejection, "shape_silent");
  assert.equal(r.grounded, false);
});

test("11.5: the acknowledgement and the change-of-subject phrase are ONE utterance", () => {
  // They used to be two synthesis calls with a beat of silence between them, and nobody talks with a
  // pause between every clause. Fusing is most of what "sounds human" actually is: pacing.
  const fused = groundedAck.bridgeInto("The Mumbai launch, okay", "Let me move us on to a different area.");
  assert.equal(fused, "The Mumbai launch, okay. Let me move us on to a different area.");
  // A fragment with no terminal punctuation must not run into the bridge as one garbled sentence.
  assert.match(fused, /okay\. Let me/);
});

test("11.6: fusing is a no-op when either half is missing", () => {
  assert.equal(groundedAck.bridgeInto("You mentioned the queue.", ""), "You mentioned the queue.");
  assert.equal(groundedAck.bridgeInto("", "Let me move on."), "Let me move on.");
  assert.equal(groundedAck.bridgeInto("", ""), "");
});

test("11.7: fusing composes two approved strings — it can never launder an unapproved one", () => {
  // The bridge half comes from the boot-checked bank and the acknowledgement half has passed every
  // check in groundedAck, so the joined line inherits both guarantees rather than escaping either.
  for (const bridge of backchannel.phrases("bridge", { firstName: "Vijendra" })) {
    const fused = groundedAck.bridgeInto("You mentioned the queue.", bridge);
    assert.equal(backchannel.findEvaluativeWord(fused), null, `fused line must stay non-evaluative: ${fused}`);
  }
});

test("11.8: rating is refused at EVERY shape index, not just the default one", () => {
  for (let i = 0; i < groundedAck.SHAPES.length; i += 1) {
    const r = groundedAck.decide(
      { leadIn: "Yes, that's correct — the AI recruitment platform.", term: "AI recruitment platform" },
      ANSWER,
      { index: i }
    );
    assert.equal(r.grounded, false, `shape ${groundedAck.shapeFor(i).key} must not admit a verdict`);
  }
});

test("11.9: an invented term is caught whatever its capitalisation", () => {
  // Containment is case-insensitive so a capitalised echo of the candidate's own words is not
  // discarded — that must not weaken the check into matching words they never said.
  for (const term of ["Kubernetes", "kubernetes", "KUBERNETES"]) {
    const r = groundedAck.decide({ leadIn: `You mentioned ${term}.`, term }, ANSWER, { index: 2 });
    assert.equal(r.rejection, "term_not_in_answer", `${term} was never said and must not be attributed`);
  }
});

test("11.10: a short term still cannot match inside a longer word", () => {
  assert.equal(groundedAck.containsPhrase("We used Google Cloud throughout.", "Go"), false);
  assert.equal(groundedAck.containsPhrase("I used Node.js there.", "Node"), true);
});

test("11.11: the model is steered toward speech, and told the constraint that would silence it", () => {
  const prompt = followUpPrompts.reflectPrompt({
    roleTitle: "Performance Marketing Manager",
    roleContext: "Paid social.",
    question: "Have you run paid social?",
    answer: "I ran the Mumbai launch on Meta, about two thousand leads a week.",
    followUpsRemaining: 2,
    shapeHint: groundedAck.shapeFor(0).hint,
  });
  assert.match(prompt, /FRAGMENT/, "it must be told to speak in fragments, not sentences");
  assert.match(prompt, /USE THIS SHAPE THIS TIME/, "the rotated frame must reach the model");
  assert.match(prompt, /character for character, in BOTH/, "the containment rule must be explicit");
  assert.ok(
    prompt.includes(String(groundedAck.TARGET_LEAD_IN_WORDS)),
    "the target length must be stated, not just the ceiling"
  );
});
