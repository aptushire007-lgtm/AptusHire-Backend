// Phase 0 of the "make the voice human" work — the changes that came out of a real candidate's
// feedback after sitting the interview:
//
//   1. Nobody was greeted. The intro turn existed and was rendered on screen, but nothing ever
//      spoke it, so a voice candidate was dropped into question one by a stranger.
//   2. The interview opened cold on a rubric question instead of easing in.
//   3. Silence ended the turn on a timer, which the candidate experienced as being cut off.
//   4. "Thank you." between every answer read as talking into a void.
//   5. Written-form text ("5+ years", "CI/CD") was read aloud literally and sounded unclear.
//
// The gates below are the ones that must not regress — in particular that the warm-up NEVER
// reaches a score, and that added warmth never becomes an assessment.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const aiInterview = require("../../services/aiInterviewService");
const backchannel = require("../../utils/backchannel");
const speakable = require("../../utils/speakable");

function refs() {
  return {
    candidate: { basicDetails: { name: "Govind Sharma", email: "g@example.com" } },
    job: { title: "Backend Engineer" },
    persona: { name: "Jane" },
  };
}

// ---------------------------------------------------------------------------
// 1. The spoken opening
// ---------------------------------------------------------------------------

test("0.1: the opening greets the candidate by name, in the interviewer's name", () => {
  const { candidate, job, persona } = refs();
  const { intro } = aiInterview.openingScript({ candidate, job, persona, maxQuestions: 8 });
  assert.match(intro, /\bGovind\b/, "the candidate is greeted by their first name");
  assert.ok(!intro.includes("Sharma"), "by first name only — this is a greeting, not a records check");
  assert.match(intro, /\bJane\b/, "the interviewer introduces itself by the persona's name");
  assert.match(intro, /Backend Engineer/, "the candidate is told which role this is for");
});

test("0.2: the opening sets expectations — how many questions, how long, and that there's no rush", () => {
  const { candidate, job, persona } = refs();
  const { intro } = aiInterview.openingScript({ candidate, job, persona, maxQuestions: 8 });
  // The number quoted has to be the number the candidate could ACTUALLY be asked, not the approved
  // budget alone. The interview also runs a code-authored closing sequence and up to
  // MAX_FOLLOW_UPS adaptive follow-ups (utils/closingQuestions, utils/followUpPrompts), so a
  // candidate promised "around 8" who is answering their fourteenth has been misled about the one
  // fact they may have planned their day around. Asserted as a ceiling ("up to N") rather than an
  // exact count, because how many follow-ups a candidate earns genuinely varies with their answers.
  const quoted = Number((intro.match(/up to (\d+) questions/) || [])[1]);
  assert.ok(
    Number.isFinite(quoted) && quoted >= 8,
    `the stated question count must cover the whole interview, not just the approved budget: ${intro}`
  );
  assert.match(intro, /minutes/, "the expected duration is stated up front");
  assert.match(intro, /no rush|take the time/i, "permission to think is given out loud");
});

test("0.3: the opening announces the repeat affordance, which has always existed and was never mentioned", () => {
  const { candidate, job, persona } = refs();
  const { intro } = aiInterview.openingScript({ candidate, job, persona, maxQuestions: 8 });
  assert.match(intro, /repeat/i, "the candidate is told they can ask for a question again");
});

test("0.4: a missing name or persona degrades to something sayable, never to 'Hi undefined'", () => {
  const { intro } = aiInterview.openingScript({
    candidate: { basicDetails: {} },
    job: {},
    persona: {},
    maxQuestions: 5,
  });
  assert.ok(!/undefined|null|NaN/.test(intro), `the greeting must stay speakable: ${intro}`);
  assert.match(intro, /^Hi there\b/, "an unnamed candidate is still greeted");
});

test("0.5: the duration estimate is a rounded estimate, and never absurdly small", () => {
  assert.equal(aiInterview.estimatedMinutes(8), 20);
  assert.equal(aiInterview.estimatedMinutes(1), 5, "a one-question interview still reads as ~5 minutes");
  assert.ok(aiInterview.estimatedMinutes(20) >= 40);
});

test("0.6: the warm-up asks for a self-introduction and is not a rubric question", () => {
  const { candidate, job, persona } = refs();
  const { warmup } = aiInterview.openingScript({ candidate, job, persona, maxQuestions: 8 });
  assert.match(warmup, /introduction|introduce/i);
  assert.ok(!/Backend Engineer/.test(warmup), "the warm-up is about them, not yet about the role");
});

test("0.7: the closing thanks the candidate by name and states what happens next", () => {
  const closing = aiInterview.closingScript({ basicDetails: { name: "Govind Sharma" } });
  assert.match(closing, /\bGovind\b/);
  assert.match(closing, /next steps|be in touch/i, "the candidate is told what happens now");
  assert.ok(!/undefined/.test(aiInterview.closingScript({})), "a nameless closing is still sayable");
});

// ---------------------------------------------------------------------------
// 2. BIAS GATE — the warm-up never reaches a score
// ---------------------------------------------------------------------------
//
// "Tell me about yourself" has no criterion behind it. A number attached to it would be a
// judgement with nothing to justify it, and it would drag the mean a real hiring decision reads.

test("0.8: BIAS GATE — a warm-up answer is never scored, even at finalisation", async () => {
  const ai = {
    turns: [
      { role: "ai", kind: "intro", text: "Hi Govind, my name is Jane." },
      { role: "ai", kind: "warmup", text: "Could you start with a short introduction?" },
      { role: "candidate", kind: "warmup_answer", text: "Sure — I'm a backend engineer with six years on payments systems." },
      { role: "ai", kind: "question", text: "Q1?" },
      { role: "candidate", kind: "answer", text: "A substantive answer about idempotency keys and retry semantics in payment capture." },
    ],
  };
  await aiInterview.scoreUnscoredAnswers({
    session: { _id: new mongoose.Types.ObjectId(), company: new mongoose.Types.ObjectId() },
    candidate: { _id: new mongoose.Types.ObjectId(), basicDetails: { name: "Govind" }, skills: [], experience: [], education: [], projects: [], ats: {} },
    job: { title: "Backend Engineer", description: "d", requiredSkills: [], minExperienceYears: 0 },
    settings: null,
    ai,
    useAi: false,
  });
  assert.equal(ai.turns[2].answerScore, undefined, "the self-introduction carries no score");
  assert.equal(typeof ai.turns[4].answerScore, "number", "a real answer still gets one");
});

test("0.9: an unscored warm-up is EXCLUDED from the overall mean, not counted as a zero", () => {
  const evalOut = aiInterview.fallbackEvaluation({
    turns: [
      { role: "candidate", kind: "warmup_answer", text: "I'm a backend engineer." },
      { role: "candidate", kind: "answer", text: "answer one", answerScore: 80 },
      { role: "candidate", kind: "answer", text: "answer two", answerScore: 60 },
    ],
  });
  assert.equal(evalOut.overallScore, 70, "the mean is over the two real answers only");
});

// ---------------------------------------------------------------------------
// 3. Warmth that is not an assessment
// ---------------------------------------------------------------------------

test("0.10: BIAS GATE — the warmer acknowledgements still say nothing about the answer", () => {
  for (const phrase of backchannel.phrases("acknowledge")) {
    assert.equal(
      backchannel.findEvaluativeWord(phrase),
      null,
      `"${phrase}" must acknowledge that the candidate spoke, never how well`
    );
  }
  // The specific wording the feedback asked for, and why it cannot ship: it is an assessment
  // delivered to the candidate with no human in the loop, and it varies with the answer.
  assert.ok(backchannel.findEvaluativeWord("Well answered — you seem very experienced."));
});

test("0.11: warmth is uniform — the same rotation for every candidate at the same turn index", () => {
  const first = backchannel.phraseFor("acknowledge", 3);
  assert.equal(backchannel.phraseFor("acknowledge", 3), first, "reproducible from the index alone");
  assert.ok(backchannel.phrases("acknowledge").length > 1, "varied enough not to sound like a loop");
});

test("0.12: the end-of-turn confirmation is in the bank, non-evaluative, and shipped to the client", () => {
  const confirms = backchannel.phrases("confirm");
  assert.ok(confirms.length > 0, "there is something to say before ending a turn");
  for (const phrase of confirms) assert.equal(backchannel.findEvaluativeWord(phrase), null);
  assert.match(confirms[0], /add\?$/, "it asks, rather than announcing that time is up");

  const policy = backchannel.clientPolicy();
  assert.deepEqual(policy.confirmations, confirms, "the client is given the words, never invents them");
  assert.ok(policy.confirmGraceMs > 0, "and how long to wait for the answer");
});

test("0.13: a confirmation is a recordable backchannel kind, so it can never be filed as a question", () => {
  assert.ok(backchannel.KINDS.includes("confirm"));
  assert.ok(backchannel.isBankPhrase(backchannel.phrases("confirm")[0]));
});

// ---------------------------------------------------------------------------
// 4. Written form -> spoken form
// ---------------------------------------------------------------------------

test("0.14: written shorthand is rendered as a person would say it", () => {
  const cases = [
    ["Do you have 5+ years with K8s?", /5 plus years/, /Kubernetes/],
    ["Tell me about your CI/CD setup.", /C I, C D/],
    ["Have you used gRPC, e.g. for internal services?", /G R P C/, /for example/],
    ["Describe a 3x throughput improvement.", /3 times/],
    ["Roughly 3-5 years of Node.js.", /3 to 5 years/, /Node J S/],
    ["Experience with C# or C++?", /C sharp/, /C plus plus/],
    ["Was that a REST/gRPC boundary?", /REST, G R P C/],
    ["A 24/7 on-call rota, Q&A included.", /twenty four seven/, /Q and A/],
  ];
  for (const [input, ...expected] of cases) {
    const { text } = speakable.toSpeakable(input);
    for (const re of expected) assert.match(text, re, `${JSON.stringify(input)} -> ${JSON.stringify(text)}`);
  }
});

test("0.15: ordinary prose is left completely alone", () => {
  const untouched = [
    "Tell me about a project you're most proud of and your specific role in it.",
    "How do you approach debugging a problem you've never seen before?",
    "Was that decision yours and/or the team's?",
  ];
  for (const input of untouched) {
    assert.equal(speakable.toSpeakable(input).text, input, "no rule may fire on plain English");
  }
});

test("0.16: the longest matching term wins, so a shorter one cannot eat it", () => {
  assert.match(speakable.toSpeakable("Any ASP.NET experience?").text, /A S P dot NET/);
  assert.match(speakable.toSpeakable("Any .NET experience?").text, /\bdot NET\b/);
});

test("0.17: the mapping is deterministic — the same question always sounds the same", () => {
  const q = "Do you have 5+ years with K8s and CI/CD?";
  const a = speakable.toSpeakable(q);
  const b = speakable.toSpeakable(q);
  assert.deepEqual(a, b, "reproducible from the authored text alone, so nothing extra need be stored");
});

test("0.18: it never changes meaning — every word of the original survives or is expanded", () => {
  // The one property that matters: rendering must not turn a question into a different question.
  const { text } = speakable.toSpeakable("Describe your CI/CD pipeline for a 5+ year old service.");
  assert.match(text, /Describe your/);
  assert.match(text, /pipeline for a/);
  assert.match(text, /year old service/);
});

test("0.19: empty and null input are handled without throwing", () => {
  assert.equal(speakable.toSpeakable("").text, "");
  assert.equal(speakable.toSpeakable(null).text, "");
  assert.equal(speakable.toSpeakable(undefined).text, "");
});
