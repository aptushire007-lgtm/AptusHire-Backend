// Dialogue acts — the candidate talking ABOUT the interview rather than into it.
//
// These tests are mostly about the two errors this feature can make, and they are not
// symmetrical:
//
//   FALSE POSITIVE — reading a real answer as an act. Costs the candidate evidence, and in the
//     withdraw case costs them the interview. This is the one that has to be nailed shut, which
//     is why most of section 1 is phrases containing a trigger inside a genuine answer.
//   FALSE NEGATIVE — missing an act. Costs one more question, which the candidate can decline.
//
// Everything here is deterministic and pure: no DB, no network, no model.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const dialogueActs = require("../../utils/dialogueActs");
const backchannel = require("../../utils/backchannel");
const aiInterview = require("../../services/aiInterviewService");
const probeService = require("../../services/probeService");
const InterviewSession = require("../../models/InterviewSession");

// ---------------------------------------------------------------------------
// 1. Detection — the false-positive wall
// ---------------------------------------------------------------------------

test("1.1: a bare decline is honoured", () => {
  for (const said of [
    "I don't know.",
    "I dont know",
    "No idea.",
    "Um, honestly, I don't know that one, sorry.",
    "Can we skip this one?",
    "I've never used that.",
  ]) {
    const d = dialogueActs.detect(said);
    assert.equal(d.act, "decline", `should be a decline: ${said}`);
    assert.equal(d.honour, true, `should be honoured: ${said}`);
  }
});

test("1.2: THE CRITICAL CASE — a trigger inside a real answer is NOT an act", () => {
  // Every one of these is a candidate answering well. Reading any of them as a decline would
  // delete their answer from the score; reading the withdraw ones as a withdrawal would end
  // their interview outright.
  const answers = [
    "I don't know the exact number, but we ran three brokers and the consumer lag never went above about two seconds under peak load.",
    "I'm not sure I'd call it a microservice — it was really a worker pulling off a queue, and it shared the primary database with the monolith.",
    "I don't want to do this manually, so I wrote a script that diffs the two schemas and emits the migration.",
    "No idea why they chose Mongo originally, but by the time I joined we had about forty collections and the join logic was all in application code.",
    "I have no idea how the vendor implemented it internally, though from the latency profile I'd guess they were batching writes.",
    "We couldn't stop the rollout at that point, so we shipped the flag off and backfilled overnight.",
  ];
  for (const said of answers) {
    const d = dialogueActs.detect(said);
    assert.equal(d.honour, false, `must NOT be honoured as an act: ${said}`);
  }
});

test("1.3: withdraw is tighter than decline, and both are bounded by what else was said", () => {
  assert.equal(dialogueActs.detect("I want to stop.").honour, true);
  assert.equal(dialogueActs.detect("Sorry, I want to stop.").honour, true);
  // Four extra words is past the withdraw limit of three — a longer sentence is an answer.
  const chatty = dialogueActs.detect("I want to stop because the connection keeps dropping");
  assert.equal(chatty.act, "withdraw");
  assert.equal(chatty.honour, false, "past maxOtherWords, a withdraw phrase is not a withdrawal");
});

test("1.4: withdraw outranks decline when an utterance could be read as either", () => {
  const d = dialogueActs.detect("I don't know, I want to stop");
  assert.equal(d.act, "withdraw", "the more consequential reading wins, and it needs confirming");
  assert.equal(d.needsConfirmation, true);
});

test("1.5: only withdraw needs confirmation", () => {
  assert.equal(dialogueActs.detect("I don't know").needsConfirmation, false);
  assert.equal(dialogueActs.detect("Give me a second").needsConfirmation, false);
  assert.equal(dialogueActs.detect("I want to stop").needsConfirmation, true);
});

test("1.6: empty and non-act speech produce no act", () => {
  for (const said of ["", "   ", "We used Postgres with a read replica."]) {
    assert.equal(dialogueActs.detect(said).act, null);
  }
});

// ---------------------------------------------------------------------------
// 2. Confirming a withdrawal — the asymmetry
// ---------------------------------------------------------------------------

test("2.1: only a recognised yes confirms; everything else means carry on", () => {
  assert.equal(dialogueActs.detectConfirmation("Yes"), "yes");
  assert.equal(dialogueActs.detectConfirmation("yeah, end it"), "yes");
  assert.equal(dialogueActs.detectConfirmation("No"), "no");
  assert.equal(dialogueActs.detectConfirmation("no, carry on"), "no");
  assert.equal(dialogueActs.detectConfirmation("sorry, my mistake"), "no");
  // Not recognisable as an answer to the question ⇒ null, which every caller treats as "no".
  assert.equal(dialogueActs.detectConfirmation("hmm"), null);
  assert.equal(dialogueActs.detectConfirmation(""), null);
});

test("2.2: SAFETY — a mixed reply is never read as a yes", () => {
  assert.equal(dialogueActs.detectConfirmation("no, yes I mean carry on"), "no");
  assert.equal(dialogueActs.detectConfirmation("yes sorry no keep going"), "no");
});

test("2.3: a long reply is not a confirmation at all", () => {
  const long = "yes so as I was saying the deployment pipeline had three separate stages and";
  assert.equal(dialogueActs.detectConfirmation(long), null, "they carried on talking — not a confirmation");
});

// ---------------------------------------------------------------------------
// 3. The approved replies
// ---------------------------------------------------------------------------

test("3.1: every dialogue-act reply is in the bank and non-evaluative", () => {
  for (const kind of ["decline", "withdraw_confirm", "withdraw_cancel", "pause"]) {
    const list = backchannel.phrases(kind);
    assert.ok(list.length > 0, `${kind} has phrases`);
    for (const phrase of list) {
      assert.equal(backchannel.findEvaluativeWord(phrase), null, `${phrase} must not rate the candidate`);
      assert.equal(backchannel.isBankPhrase(phrase), true);
    }
  }
});

test("3.2: the replies reach the browser, and the browser cannot substitute its own", () => {
  const policy = backchannel.clientPolicy();
  assert.deepEqual(policy.declineReplies, backchannel.phrases("decline"));
  assert.deepEqual(policy.withdrawConfirmations, backchannel.phrases("withdraw_confirm"));
  assert.deepEqual(policy.pauseReplies, backchannel.phrases("pause"));
  // The confirmation names both options, so a candidate who triggered it by accident knows that
  // doing nothing keeps them in the interview.
  assert.match(policy.withdrawConfirmations[0], /carry on/i);
});

test("3.3: the new backchannel kinds are storable", () => {
  const kinds = InterviewSession.schema
    .path("aiInterview")
    .schema.path("backchannels")
    .schema.path("kind").enumValues;
  for (const k of ["decline", "withdraw_confirm", "withdraw_cancel", "pause"]) {
    assert.ok(kinds.includes(k), `${k} must be a storable backchannel kind`);
  }
});

// ---------------------------------------------------------------------------
// 4. A decline is not a zero
// ---------------------------------------------------------------------------

function turns(...list) {
  return list;
}

test("4.1: coverageStats separates answered from declined", () => {
  const ai = {
    questionCount: 4,
    turns: turns(
      { role: "ai", kind: "warmup", text: "Tell me about yourself" },
      { role: "candidate", kind: "warmup_answer", text: "I'm a backend engineer" },
      { role: "ai", kind: "question", text: "Q1" },
      { role: "candidate", kind: "answer", text: "A real answer", answerScore: 70 },
      { role: "ai", kind: "question", text: "Q2" },
      { role: "candidate", kind: "answer", text: "I don't know", declined: true },
      { role: "ai", kind: "question", text: "Q3" },
      { role: "candidate", kind: "answer", text: "Another real answer", answerScore: 60 },
      { role: "ai", kind: "question", text: "Q4" },
      { role: "candidate", kind: "answer", text: "No idea", declined: true }
    ),
  };
  // `noResponse` is the subset of declines where nothing was captured at all rather than the
  // candidate saying something — zero here, because both of these declines were spoken.
  const stats = aiInterview.coverageStats(ai);
  const { resume, ...counts } = stats;
  assert.deepEqual(counts, { asked: 4, answered: 2, declined: 2, noResponse: 0 });
  // This session has neither claim-probes nor résumé anchors, so the résumé block must say so
  // rather than being absent — an interview that never referenced the document has to be
  // distinguishable from one that did (rule 5).
  assert.equal(resume.grounded, false);
  assert.equal(resume.anchorsTotal, 0);
  assert.equal(resume.probesTotal, 0);
});

test("4.2: a declined turn carries no answerScore, so it never enters the mean", () => {
  const ai = {
    turns: turns(
      { role: "candidate", kind: "answer", text: "good", answerScore: 80 },
      { role: "candidate", kind: "answer", text: "I don't know", declined: true }
    ),
  };
  const evaluation = aiInterview.fallbackEvaluation(ai);
  assert.equal(evaluation.overallScore, 80, "the decline must not drag the mean toward zero");
});

test("4.3: the schema can record a decline verbatim, flagged", () => {
  const turnSchema = InterviewSession.schema.path("aiInterview").schema.path("turns").schema;
  assert.ok(turnSchema.path("declined"), "a decline is flagged, not inferred from its text");
  // It stays kind "answer" so the reviewer still sees it in the transcript.
  assert.ok(turnSchema.path("kind").enumValues.includes("answer"));
});

// ---------------------------------------------------------------------------
// 5. Declining never becomes evidence AGAINST the candidate
// ---------------------------------------------------------------------------

test("5.1: THE ADVERSE-FINDING GUARD — a declined probe answer never reaches the verdict model", () => {
  const list = turns(
    { role: "ai", kind: "question", text: "Tell me about the Kafka migration", probeId: "c1" },
    { role: "candidate", kind: "answer", text: "I don't know", declined: true }
  );
  const probe = { claimId: "c1", turnIndex: 0 };
  // Empty ⇒ assessVerdicts filters it out before the prompt is built. If this ever returns the
  // decline text, the model gets asked whether "I don't know" contradicts the résumé claim, and
  // it will sometimes say yes — manufacturing a serious adverse finding out of an absence.
  assert.equal(probeService.answerTextForProbe(list, probe), "");
  assert.deepEqual(probeService.declinedProbeClaimIds(list, [probe]), ["c1"]);
});

test("5.2: a real answer to a probe still reaches the verdict model", () => {
  const list = turns(
    { role: "ai", kind: "question", text: "Tell me about the Kafka migration", probeId: "c1" },
    { role: "candidate", kind: "answer", text: "We moved 40 topics over about six weeks." }
  );
  const probe = { claimId: "c1", turnIndex: 0 };
  assert.match(probeService.answerTextForProbe(list, probe), /40 topics/);
  assert.deepEqual(probeService.declinedProbeClaimIds(list, [probe]), []);
});

test("5.3: inconclusive is a storable verdict — the decline has somewhere honest to land", () => {
  const verdicts = InterviewSession.schema
    .path("aiInterview")
    .schema.path("probes")
    .schema.path("verdict").enumValues;
  assert.ok(verdicts.includes("inconclusive"));
});

// ---------------------------------------------------------------------------
// 6. Ending early is never an automated adverse action (rule 6)
// ---------------------------------------------------------------------------

test("6.1: a withdrawn interview always withholds the automated recommendation", () => {
  const reason = aiInterview.reviewRequiredReason({ status: "ended_early", questionCount: 2, turns: [] });
  assert.ok(reason, "an early end must force human review");
  assert.match(reason, /end the interview/i);
});

test("6.2: declining most of the interview also withholds it", () => {
  const ai = {
    status: "completed",
    questionCount: 4,
    turns: turns(
      { role: "candidate", kind: "answer", text: "a", answerScore: 70 },
      { role: "candidate", kind: "answer", text: "I don't know", declined: true },
      { role: "candidate", kind: "answer", text: "no idea", declined: true },
      { role: "candidate", kind: "answer", text: "I'm not sure", declined: true }
    ),
  };
  const reason = aiInterview.reviewRequiredReason(ai);
  assert.ok(reason, "3 of 4 declined leaves too little evidence to recommend on");
  assert.match(reason, /declined 3 of 4/);
});

test("6.3: an ordinary interview is NOT forced to review — the guard is targeted, not blanket", () => {
  const ai = {
    status: "completed",
    questionCount: 4,
    turns: turns(
      { role: "candidate", kind: "answer", text: "a", answerScore: 70 },
      { role: "candidate", kind: "answer", text: "b", answerScore: 65 },
      { role: "candidate", kind: "answer", text: "c", answerScore: 80 },
      { role: "candidate", kind: "answer", text: "I don't know", declined: true }
    ),
  };
  assert.equal(aiInterview.reviewRequiredReason(ai), null, "one decline in four is a normal interview");
});

test("6.4: ended_early is a distinct terminal state, not a flavour of completed", () => {
  const statuses = InterviewSession.schema.path("aiInterview").schema.path("status").enumValues;
  assert.ok(statuses.includes("ended_early"));
  assert.ok(statuses.includes("completed"));
});

test("6.5: the withdrawal is recorded with the evidence that produced it", () => {
  const ai = InterviewSession.schema.path("aiInterview").schema;
  for (const field of [
    "endedEarly.by",
    "endedEarly.requestText",
    "endedEarly.matchedTrigger",
    "endedEarly.confirmedBy",
    "endedEarly.at",
  ]) {
    assert.ok(ai.path(field), `${field} must be recorded — "the candidate chose to stop" is a claim we must substantiate`);
  }
  assert.deepEqual([...ai.path("endedEarly.confirmedBy").enumValues].sort(), ["explicit", "spoken"]);
});

test("6.6: the withdrawal closing applies no pressure and promises a human", () => {
  const script = aiInterview.withdrawalScript({ basicDetails: { name: "Priya Sharma" } });
  assert.match(script, /Priya/, "greeted by name, as everywhere else");
  assert.match(script, /a person will review it/i, "rule 6: a human, stated to the candidate");
  // No second-guessing at the moment someone has said they want to stop.
  assert.doesNotMatch(script, /are you sure|reconsider|why|instead/i);
});

// ---------------------------------------------------------------------------
// 7. The evaluation carries its own coverage
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 8. The server does not take the client's word for it
// ---------------------------------------------------------------------------
//
// Every one of these reaches the real submitDialogueAct with a stub session, and every one must
// be refused BEFORE any database work — which is also why they run without a DB. A client that
// posts {act: "withdraw"} cannot end an interview; it has to produce a request the server reads
// as a request and a confirmation the server reads as a yes.

function stubSession() {
  return {
    _id: "s1",
    company: "c1",
    aiInterview: { status: "in_progress", questionCount: 2, turns: [], backchannels: [], probes: [], mustAsk: [] },
    save: async () => {},
  };
}

test("8.1: an interview is never ended without a request the SERVER reads as one", async () => {
  await assert.rejects(
    () =>
      aiInterview.submitDialogueAct(stubSession(), "withdraw", {
        // A real answer that happens to contain the words. The client should never have flagged
        // this, and if it does, the server refuses.
        text: "I was going to stop the deployment but the rollback finished first",
        confirmText: "yes",
        confirmedBy: "spoken",
      }),
    (err) => err.code === "WITHDRAW_NOT_RECOGNISED"
  );
});

test("8.2: THE ASYMMETRY — only an explicit yes ends it; no, silence and noise all continue", async () => {
  for (const confirmText of ["no", "carry on", "", "ummm", "sorry what was that"]) {
    await assert.rejects(
      () =>
        aiInterview.submitDialogueAct(stubSession(), "withdraw", {
          text: "I want to stop",
          confirmText,
          confirmedBy: "spoken",
        }),
      (err) => err.code === "WITHDRAW_NOT_CONFIRMED",
      `"${confirmText}" must NOT end an interview`
    );
  }
});

test("8.3: an act on an interview that is not running is refused", async () => {
  const s = stubSession();
  s.aiInterview.status = "completed";
  await assert.rejects(
    () => aiInterview.submitDialogueAct(s, "decline", { text: "I don't know" }),
    /not in progress/i
  );
});

test("8.4: an unknown act is refused rather than guessed at", async () => {
  await assert.rejects(
    () => aiInterview.submitDialogueAct(stubSession(), "reschedule", {}),
    /Unknown conversational act/i
  );
});

// ---------------------------------------------------------------------------
// 9. The headline verdict must not auto-reject the people who used the exit
// ---------------------------------------------------------------------------
//
// computeVerdict is a SECOND, independent adverse-decision path — separate from the model's
// recommendation, computed deterministically in the report layer. Forcing the recommendation to
// "review" does nothing here, so it needs its own guards. Before them, a candidate who withdrew
// after answering nothing hit the very first branch — CLEAR_REJECT at High confidence — which
// would have made the exit a trap rather than a way out.

const { computeVerdict, computeAnswerSubstance } = require("../../utils/interviewReportEngine");

test("9.1: THE TRAP — withdrawing with nothing answered is REVIEW, never CLEAR_REJECT", () => {
  const v = computeVerdict({ responsiveCount: 0, totalAnswers: 0, engineRan: true, overallScore: null, endedEarly: true });
  assert.equal(v.verdict, "REVIEW");
  assert.notEqual(v.verdict, "CLEAR_REJECT");
});

test("9.2: an early end never produces an automated ADVANCE either", () => {
  // The guard is against automated judgement on a partial transcript, in BOTH directions — a
  // one-question interview is not evidence for a hire any more than against one.
  const v = computeVerdict({ responsiveCount: 1, totalAnswers: 1, engineRan: true, overallScore: 95, endedEarly: true });
  assert.equal(v.verdict, "REVIEW");
});

test("9.3: declines are out of the responsiveness denominator, so they cannot drive a reject", () => {
  const substance = computeAnswerSubstance([
    { role: "ai", kind: "question", text: "Q1" },
    { role: "candidate", kind: "answer", text: "A full, substantive answer about the migration we ran last year and why." },
    { role: "candidate", kind: "answer", text: "I don't know", declined: true },
    { role: "candidate", kind: "answer", text: "No idea", declined: true },
    { role: "candidate", kind: "answer", text: "I'm not sure", declined: true },
  ]);
  assert.equal(substance.totalAnswers, 1, "only attempted answers are in the denominator");
  assert.equal(substance.responsiveCount, 1);
  assert.equal(substance.declinedCount, 3, "but the declines are still reported");
  // Left in the denominator this was 1/4 = 25% → CLEAR_REJECT at High confidence.
  const v = computeVerdict({ ...substance, engineRan: true, overallScore: 70 });
  assert.notEqual(v.verdict, "CLEAR_REJECT");
});

test("9.4: an interview of nothing but declines routes to a human, not to a reject", () => {
  const substance = computeAnswerSubstance([
    { role: "candidate", kind: "answer", text: "I don't know", declined: true },
    { role: "candidate", kind: "answer", text: "No idea", declined: true },
  ]);
  const v = computeVerdict({ ...substance, engineRan: true, overallScore: null });
  assert.equal(v.verdict, "REVIEW", "they engaged with every question and told the truth about each");
  assert.match(v.reason, /declined all 2/);
});

test("9.5: the guard is targeted — a genuinely empty interview still rejects", () => {
  // Nothing said at all, no declines, not ended early. That branch must survive intact, or the
  // fix above would have quietly disabled a legitimate deterministic reject.
  const v = computeVerdict({ responsiveCount: 0, totalAnswers: 0, engineRan: true, overallScore: null });
  assert.equal(v.verdict, "CLEAR_REJECT");
  // And an ordinary weak interview is unaffected.
  const weak = computeVerdict({ responsiveCount: 0, totalAnswers: 4, engineRan: true, overallScore: 20 });
  assert.equal(weak.verdict, "CLEAR_REJECT");
});

test("7.1: a score is stored alongside what it was a score OF", () => {
  const evalSchema = InterviewSession.schema.path("aiInterview").schema.path("evaluation").schema;
  for (const field of ["questionsAsked", "questionsAnswered", "questionsDeclined", "reviewReason"]) {
    assert.ok(evalSchema.path(field), `${field} must travel with the score`);
  }
});
