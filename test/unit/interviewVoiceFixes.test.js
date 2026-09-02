// The eight reported voice-interview failures, each as a test that fails if the fix is removed.
//
// Grouped by the complaint rather than by module on purpose: "it repeats questions" is the thing
// that has to stay fixed, and the mechanism that fixes it is free to change underneath.

const test = require("node:test");
const assert = require("node:assert");

const questionSimilarity = require("../../utils/questionSimilarity");
const resumeAnchors = require("../../utils/resumeAnchors");
const difficultyLadder = require("../../utils/difficultyLadder");
const followUpPrompts = require("../../utils/followUpPrompts");
const interviewPrompts = require("../../utils/interviewPrompts");
const aiInterview = require("../../services/aiInterviewService");
const InterviewSession = require("../../models/InterviewSession");

// ---------------------------------------------------------------------------
// 1. Not asking questions from the résumé
// ---------------------------------------------------------------------------

const RESUME_TEXT = [
  "VIJENDRA PRATAP",
  "Software Engineer",
  "",
  "EXPERIENCE",
  "Backend Engineer @ Meta (2022-2024)",
  "Built the lead ingestion queue in Node.js handling 2000 leads a week.",
  "",
  "PROJECTS",
  "AI Recruitment Platform [Node.js, MongoDB] - resume screening and interview scheduling.",
  "",
  "SKILLS",
  "Node.js, MongoDB, Kubernetes, React",
].join("\n");

function candidateFixture(overrides = {}) {
  return {
    resumeText: RESUME_TEXT,
    skills: ["Node.js", "MongoDB", "Kubernetes", "React"],
    experience: [{ role: "Backend Engineer", company: "Meta", description: "lead ingestion queue in Node.js" }],
    projects: [{ title: "AI Recruitment Platform", techStack: "Node.js, MongoDB", description: "resume screening" }],
    ...overrides,
  };
}

const JOB = { requiredSkills: ["Node.js", "Kubernetes", "Go"], title: "Backend Engineer" };

test("1.1: a résumé produces required coverage with NO rubric, no ClaimGraph and no model call", () => {
  // This is the whole point. The claim-probe engine needs an approved RoleRubric for the job, and
  // without one probeService returns zero probes and the interview never mentions the document.
  // Anchors are derived from the candidate's own résumé with none of that machinery.
  const { anchors } = resumeAnchors.selectAnchors(candidateFixture(), JOB);
  assert.ok(anchors.length > 0, "a résumé with projects and skills must yield anchors");
  assert.ok(anchors.every((a) => a.term && a.quote), "every anchor names a term and quotes the document");
});

test("1.2: anchors are ranked so a job-required skill on a real project outranks a bare skill listing", () => {
  const { anchors } = resumeAnchors.selectAnchors(candidateFixture(), JOB);
  assert.equal(anchors[0].kind, "project_required_skill");
  assert.equal(anchors[0].term, "AI Recruitment Platform");
  // The interview should ask what they did with the required skill on that project, not just
  // whether they have heard of it.
  assert.equal(anchors[0].focus, "Node.js");
});

test("1.3: CITE OR DROP — a structured field the résumé text does not support is never asked about", () => {
  const candidate = candidateFixture({
    projects: [
      { title: "AI Recruitment Platform", techStack: "Node.js" },
      // Nowhere in RESUME_TEXT. A hallucinated or stale extraction must not become a question
      // asking the candidate to account for something they never wrote.
      { title: "Quantum Ledger Rewrite", techStack: "Haskell" },
    ],
  });
  const { anchors, dropped } = resumeAnchors.selectAnchors(candidate, JOB);
  assert.ok(!anchors.some((a) => a.term === "Quantum Ledger Rewrite"));
  assert.ok(dropped.some((d) => d.term === "Quantum Ledger Rewrite" && d.reason === "not_in_resume_text"));
});

test("1.4: an anchor is only marked covered by a question that actually names it", () => {
  const { anchors } = resumeAnchors.selectAnchors(candidateFixture(), JOB);
  const anchor = anchors.find((a) => a.term === "AI Recruitment Platform");
  assert.equal(resumeAnchors.questionCoversAnchor("What did you build on the AI Recruitment Platform?", anchor), true);
  assert.equal(resumeAnchors.questionCoversAnchor("What did Node.js actually do there?", anchor), true);
  // A stamped id on an unrelated question is a FALSE coverage claim — worse than no claim, since
  // it looks equally trustworthy on the report.
  assert.equal(resumeAnchors.questionCoversAnchor("How do you handle disagreement on a team?", anchor), false);
});

test("1.5: word-edge matching — a required skill of 'Go' does not match 'Google'", () => {
  assert.equal(resumeAnchors.mentions("I worked at Google on ads", "Go"), false);
  assert.equal(resumeAnchors.mentions("I wrote it in Go, mostly", "Go"), true);
});

test("1.6: an interview cannot close while a résumé anchor is uncovered", () => {
  const ai = {
    probes: [],
    mustAsk: [],
    questionCount: 8,
    minQuestions: 4,
    resumeAnchors: [{ id: "anchor-1", term: "Meta", status: "pending" }],
  };
  assert.equal(aiInterview.closingAllowed(ai), false);
  ai.resumeAnchors[0].status = "covered";
  assert.equal(aiInterview.closingAllowed(ai), true);
});

test("1.7: coverage is reported honestly, including when there is none (rule 5)", () => {
  const bare = aiInterview.coverageStats({ turns: [], probes: [], resumeAnchors: [], probeEngineReason: "no_assessment" });
  assert.equal(bare.resume.grounded, false, "an interview that never touched the résumé must say so");
  assert.equal(bare.resume.probeEngineReason, "no_assessment", "and must say WHY there were no probes");

  const grounded = aiInterview.coverageStats({
    turns: [],
    probes: [],
    resumeAnchors: [{ id: "anchor-1", status: "covered" }, { id: "anchor-2", status: "pending" }],
  });
  assert.equal(grounded.resume.grounded, true);
  assert.equal(grounded.resume.anchorsCovered, 1);
  assert.equal(grounded.resume.anchorsTotal, 2);
});

// ---------------------------------------------------------------------------
// 2. Repeating the same question
// ---------------------------------------------------------------------------

test("2.1: a reworded repeat is caught, which string equality never would", () => {
  const asked = ["Can you explain how you've used Node.js in practice, and a limitation you ran into with it?"];
  const found = questionSimilarity.findDuplicate("How have you used Node.js in your work?", asked);
  assert.equal(found.duplicate, true);
  assert.equal(found.matched, asked[0]);
});

test("2.2: a genuinely different question on a different subject is not blocked", () => {
  const asked = [
    "Tell me about a project you're most proud of and your specific role in it.",
    "How do you approach debugging a problem you've never seen before?",
  ];
  for (const q of [
    "Which channel drove the most signups on that launch?",
    "What does 'good code' mean to you?",
    "At Meta, what were you responsible for day to day?",
  ]) {
    assert.equal(questionSimilarity.findDuplicate(q, asked).duplicate, false, `blocked a fresh question: ${q}`);
  }
});

test("2.3: the interrogative frame is stripped, so two questions are not similar just for both being questions", () => {
  // Without stopping "tell", "me", "about", "how", "what", every pair of interview questions would
  // share a third of its words before either had said anything, and the thresholds would have to
  // be raised to compensate — which is what would let the real repeats through.
  const a = "Tell me about a time you had to make a difficult decision.";
  const b = "Tell me about a time you had to learn a new tool quickly.";
  const shared = questionSimilarity.compare(a, b);
  assert.equal(shared.duplicate, false, "identical frames, different subjects — not a repeat");
  // And the frame itself contributes nothing: what overlap remains is topical, not structural.
  const frame = questionSimilarity.contentWords("Could you tell me about that, and how you would describe it?");
  assert.ok(frame.size <= 1, `the bare frame should carry almost no topic words, got ${[...frame]}`);
});

test("2.4: the regeneration notice names the offending pair rather than restating the rule that just failed", () => {
  const block = interviewPrompts.repeatBlock({
    question: "How have you used Node.js?",
    matched: "Can you explain how you used Node.js in practice?",
  });
  assert.match(block, /How have you used Node\.js\?/);
  assert.match(block, /Can you explain how you used Node\.js in practice\?/);
  assert.match(block, /DIFFERENT subject/);
});

// ---------------------------------------------------------------------------
// 3 + 4. Conversation memory, and cross-checking the résumé
// ---------------------------------------------------------------------------

const REFLECT_BASE = {
  roleTitle: "Growth Marketer",
  roleContext: "paid social and lifecycle",
  question: "What did you own on the Mumbai launch?",
  answer: "I handled a lot of the coordination and made sure everything moved along nicely on that one.",
  followUpsRemaining: 3,
  shapeHint: null,
};

test("3.1: the reflect call is given what was already said", () => {
  const prompt = followUpPrompts.reflectPrompt({
    ...REFLECT_BASE,
    history: [
      { question: "Tell me about a campaign you ran.", answer: "I ran the Mumbai launch." },
      { question: "How did you measure it?", answer: "(they said they could not answer this)" },
    ],
  });
  assert.match(prompt, /EARLIER IN THIS INTERVIEW/);
  assert.match(prompt, /I ran the Mumbai launch\./);
  // A decline appears as a decline: re-pursuing something the candidate already said they could
  // not speak to is the pressure this design exists to avoid.
  assert.match(prompt, /could not answer this/);
});

test("3.2: it is told not to re-ask what has already been covered", () => {
  const prompt = followUpPrompts.reflectPrompt({ ...REFLECT_BASE, history: [{ question: "Q", answer: "A" }] });
  assert.match(prompt, /DO NOT ask about anything already covered/);
});

test("4.1: the résumé reaches the reflect call as verified quotes", () => {
  const prompt = followUpPrompts.reflectPrompt({
    ...REFLECT_BASE,
    resumeFacts: [{ term: "Mumbai Launch", quote: "Mumbai Launch - regional rollout, owned the analytics" }],
  });
  assert.match(prompt, /RÉSUMÉ CLAIMS/);
  assert.match(prompt, /regional rollout, owned the analytics/);
});

test("4.2: a discrepancy is a REASON TO ASK, never a thing to state", () => {
  // The difference between a defensible product and an accusation delivered by a machine. "Your
  // résumé says three years but you just described six months" is the second one.
  const prompt = followUpPrompts.reflectPrompt({
    ...REFLECT_BASE,
    resumeFacts: [{ term: "Mumbai Launch", quote: "owned the analytics" }],
  });
  assert.match(prompt, /Never state the discrepancy/);
  assert.match(prompt, /never quote their résumé back at them/);
  assert.match(prompt, /never imply they have contradicted/);
});

test("4.3: with no history and no résumé, the prompt carries neither block (nothing invented)", () => {
  const prompt = followUpPrompts.reflectPrompt({ ...REFLECT_BASE, history: [], resumeFacts: [] });
  assert.ok(!/EARLIER IN THIS INTERVIEW/.test(prompt));
  assert.ok(!/RÉSUMÉ CLAIMS/.test(prompt));
});

// ---------------------------------------------------------------------------
// 6. Leaving the room mid-interview
// ---------------------------------------------------------------------------

test("6.1: a long absence routes the session to a human and is not treated as evidence", () => {
  const ai = {
    status: "completed",
    turns: [
      { role: "ai", kind: "question", text: "Q1" },
      { role: "candidate", kind: "answer", text: "a real answer here", answerScore: 70 },
    ],
    questionCount: 1,
    presence: [
      { event: "left" },
      { event: "rejoined", awayMs: 62_000 },
    ],
  };
  const reason = aiInterview.reviewRequiredReason(ai);
  assert.ok(reason, "a 62-second hole in the interview must reach a human");
  assert.match(reason, /connection dropped/);
  // The wording must not read as an accusation — this system cannot tell a tunnel from a walk-out.
  assert.match(reason, /not a judgement about them/);
});

test("6.2: a brief blip is not escalated", () => {
  const ai = {
    status: "completed",
    turns: [
      { role: "ai", kind: "question", text: "Q1" },
      { role: "candidate", kind: "answer", text: "a real answer here", answerScore: 70 },
    ],
    questionCount: 1,
    presence: [{ event: "left" }, { event: "rejoined", awayMs: 4_000 }],
  };
  assert.equal(aiInterview.reviewRequiredReason(ai), null);
});

test("6.3: every presence event the worker can send is in the schema enum", () => {
  const path = InterviewSession.schema.path("aiInterview.presence");
  const allowed = path.schema.path("event").enumValues;
  for (const event of ["left", "rejoined", "abandoned"]) {
    assert.ok(allowed.includes(event), `agent.py sends "${event}" but the schema rejects it`);
  }
});

// ---------------------------------------------------------------------------
// 8. Strictness and adaptivity
// ---------------------------------------------------------------------------

function laddered(...scores) {
  return {
    turns: scores.map((s) =>
      s === null
        ? { role: "candidate", kind: "answer", declined: true, text: "I don't know" }
        : { role: "candidate", kind: "answer", answerScore: s, text: "an answer" }
    ),
  };
}

test("8.1: the rung is a reproducible function of the recorded scores, not the model's opinion", () => {
  const a = difficultyLadder.computeRung(laddered(90, 90, 90, 90), "medium");
  const b = difficultyLadder.computeRung(laddered(90, 90, 90, 90), "medium");
  assert.deepEqual(a, b, "same transcript must always yield the same rung");
  assert.equal(a.rung, "hard");
});

test("8.2: one strong answer does not move the ladder — a run does", () => {
  assert.equal(difficultyLadder.computeRung(laddered(95), "medium").rung, "medium");
  assert.equal(difficultyLadder.computeRung(laddered(95, 95), "medium").rung, "hard");
});

test("8.3: a middling answer BREAKS the run rather than being ignored", () => {
  // "Strong, middling, strong" is not two consecutive strong answers, and climbing on it would be
  // climbing on evidence that was never consistent.
  assert.equal(difficultyLadder.computeRung(laddered(95, 60, 95), "medium").rung, "medium");
});

test("8.4: declining is not evidence of a lower level", () => {
  // Otherwise honesty is strictly the worse move, which is the opposite of what screening wants.
  assert.equal(difficultyLadder.computeRung(laddered(90, null, 90), "medium").rung, "hard");
  assert.equal(difficultyLadder.computeRung(laddered(null, null, null), "medium").rung, "medium");
});

test("8.5: the ladder cannot run off either end", () => {
  assert.equal(difficultyLadder.computeRung(laddered(...Array(12).fill(95)), "medium").rung, "hard");
  assert.equal(difficultyLadder.computeRung(laddered(...Array(12).fill(5)), "medium").rung, "easy");
});

test("8.6: the easy rung never tells the candidate the interview got easier", () => {
  const brief = difficultyLadder.briefFor("easy");
  assert.match(brief, /Do not signal that the difficulty has changed/);
  assert.match(brief, /do not comment on how the interview is going/);
  // A candidate learning their standing from the interviewer's tone is a covert score disclosure,
  // which is the same rule utils/groundedAck enforces on the acknowledgement.
  assert.ok(!/tell them|let them know/i.test(brief));
});

test("8.7: the nudge fires on a CONTENT-BLIND rule and only once per question", () => {
  const ai = {
    turns: [
      { role: "ai", kind: "question", text: "What did you own on the Mumbai launch?" },
      { role: "candidate", kind: "answer", text: "The analytics mostly." },
    ],
  };
  const target = aiInterview.nudgeTargetFor(ai);
  assert.ok(target, "a five-word answer must earn one further opportunity");
  target.nudged = true;
  assert.equal(aiInterview.nudgeTargetFor(ai), null, "twice is pressure, not a measurement");
});

test("8.8: a full answer, a decline, and the closing chat are all left alone", () => {
  const full = {
    turns: [
      { role: "ai", kind: "question", text: "Q" },
      { role: "candidate", kind: "answer", text: "I owned the analytics side of the Mumbai launch and built the reporting for it end to end." },
    ],
  };
  assert.equal(aiInterview.nudgeTargetFor(full), null);

  const declined = {
    turns: [
      { role: "ai", kind: "question", text: "Q" },
      { role: "candidate", kind: "answer", text: "I don't know", declined: true },
    ],
  };
  assert.equal(aiInterview.nudgeTargetFor(declined), null, "asking someone who just said they can't answer for more is tone-deaf");

  // The closers are short BY DESIGN (utils/closingQuestions marks them "easy"); nudging on one
  // would be the interview arguing with its own script.
  const closer = {
    turns: [
      { role: "ai", kind: "closer", text: "What do you like doing outside work?" },
      { role: "candidate", kind: "answer", text: "Cycling." },
    ],
  };
  assert.equal(aiInterview.nudgeTargetFor(closer), null);
});

test("8.9: the nudge wording is fixed, carries no verdict, and never names the candidate", () => {
  const phrase = aiInterview.NUDGE_PHRASE;
  // Uniform wording is what stops the nudge itself becoming a signal about how they are doing.
  assert.equal(phrase, "Would you like to add anything more to that?");
  for (const tell of [/short/i, /incomplete/i, /more detail/i, /not enough/i, /elaborat/i, /\{name\}/]) {
    assert.ok(!tell.test(phrase), `the nudge must not carry "${tell}"`);
  }
});

test("8.10: a press is only offered on the answer to a follow-up, and asks for a particular", () => {
  const press = followUpPrompts.reflectPrompt({ ...REFLECT_BASE, isPress: true });
  const first = followUpPrompts.reflectPrompt({ ...REFLECT_BASE, isPress: false });
  assert.match(press, /press ONCE more/);
  assert.ok(!/press ONCE more/.test(first), "a first answer is not a press");
  // A press must not become an interrogation, and must not tell them they failed to answer.
  assert.match(press, /never says or implies they have not answered/);
  assert.match(press, /being interrogated, not interviewed/);
});
