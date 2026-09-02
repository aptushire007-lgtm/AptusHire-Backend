// Reading a spoken turn that is made of several things at once.
//
// THE REGRESSION THESE TESTS EXIST FOR. In the interview of 2026-08-25 the candidate declined
// seven questions. All seven were recorded as answers and scored zero, the evaluation reported a
// decline count of zero, and the nudge — "Would you like to add anything more to that?" — was
// offered three times to a candidate who had just said he did not want to answer. The overall
// score a recruiter would have read was computed with those seven zeros in the mean.
//
// Nothing was broken in the sense of throwing. utils/dialogueActs.detect counted the words outside
// the matched trigger across the WHOLE utterance, and spoken declines do not look like that: the
// candidate wrapped each one in "you already asked me this" and "can you repeat that", which are
// not answer content but counted as though they were. Section 1 is those seven turns, verbatim.
//
// Section 2 is the direction that actually matters. A missed decline costs one question its
// correct handling. A FALSE decline deletes an answer the candidate really gave — so every case
// in section 2 contains a decline phrase inside genuine evidence and must survive as an answer.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const turnComposition = require("../../utils/turnComposition");
const dialogueActs = require("../../utils/dialogueActs");

// ---------------------------------------------------------------------------
// 1. The seven declines that were scored zero
// ---------------------------------------------------------------------------

// Verbatim speech-to-text from session 6a8d4be35ea009e6c6a3f517, turns 10/12/17/22/24/27/31.
// Quoted exactly, disfluency and all, because tidying them up would remove the thing that broke.
const REAL_DECLINES = [
  ["turn 10 — a decline wrapped in an already-answered complaint",
   "Don't you think you have asked me this about previously? I think so I have answered this " +
   "question. Also talked about this previously. I want to skip this question."],
  ["turn 12 — a refusal, said twice",
   "Don't want to talk about that. I don't want to talk about that."],
  ["turn 17 — a decline broken by an unpunctuated run-on",
   "I would like to skip this Actually, not able to no. I would like to skip this. I'm not able " +
   "to recall anything. On"],
  ["turn 22 — three repeat requests, then a decline",
   "Sorry. Can you repeat? Can you repeat? You repeat it out for me? Again? The question I " +
   "didn't it. What was the question that you asked me? Previously? I would want to skip that. " +
   "Haven't used it yet."],
  ["turn 24 — declining by naming the absence of the experience",
   "I haven't done that yet. Said I haven't done that yet."],
  ["turn 31 — a decline behind a two-word false start",
   "That's it. Want to skip this question."],
];

for (const [name, said] of REAL_DECLINES) {
  test(`1.x: ${name}`, () => {
    const r = turnComposition.classify(said);
    assert.equal(r.act, "decline", `read as ${r.act || "an answer"}`);
    assert.equal(r.honour, true);
    assert.equal(r.isAnswer, false);
    assert.equal(r.contentWords, 0);
  });
}

// The seventh is a decline mixed with a complaint and a question about the interview. What it is
// NOT is an answer — which is the whole requirement. Which act wins is a judgement call and the
// priority order records it; being scored is not.
test("1.7: a complaint carrying a decline and a meta-question is still not an answer", () => {
  const r = turnComposition.classify(
    "I think so. You asked me this before, and I said I don't want to talk about just want to " +
    "know how many questions are left Actually, this is taking too much of my time."
  );
  assert.ok(r.act, "must be read as some act");
  assert.equal(r.isAnswer, false);
  assert.equal(r.contentWords, 0);
});

test("1.8: two separate faults produced the seven zeros, and both are fixed", () => {
  // A record of WHY this module exists, kept honest about how much of the work it actually does.
  //
  // The first fault was the trigger list: nothing in it matched "I want to skip this question" or
  // "I haven't done that yet", so those turns were not declines under ANY reading. Expanding the
  // list in dialogueActs fixes those on its own, and this asserts it — a shorter list must never
  // come back.
  //
  // The second fault is structural and is what turnComposition is for: a decline stated alongside
  // other acts still defeats whole-utterance word counting, however long the trigger list gets.
  const stillMissedWholeUtterance = REAL_DECLINES.filter(([, said]) => {
    const v = dialogueActs.detect(said);
    return !(v.act === "decline" && v.honour);
  });
  assert.ok(
    stillMissedWholeUtterance.length > 0,
    "if whole-utterance detection ever catches all of these, delete this module rather than keep both"
  );
  assert.ok(
    stillMissedWholeUtterance.length < REAL_DECLINES.length,
    "the expanded trigger list must keep catching the plainly-worded declines on its own"
  );
  // Whatever whole-utterance misses, sentence-level must catch.
  for (const [name, said] of stillMissedWholeUtterance) {
    assert.equal(turnComposition.classify(said).act, "decline", name);
  }
});

// ---------------------------------------------------------------------------
// 2. The false-positive wall — an answer is never a decline
// ---------------------------------------------------------------------------

test("2.1: a decline phrase inside a real answer leaves the answer intact", () => {
  for (const said of [
    "We used Kafka for the queue and it handled about two thousand a second. I don't know the exact latency.",
    "I don't know the exact number, but we ran three brokers and the lag never went above two seconds.",
    "I'm not sure I understood the question, but I built the ingestion pipeline in Airflow with a Postgres sink.",
    "I set up the content calendar in Notion with a weekly cadence. Can you repeat the last part of the question?",
    "I have answered this question before in another interview, but the campaign ran on Meta Ads for six weeks.",
    "I haven't done that yet at this company, but at the last one I ran the whole Instagram account for two years.",
    "I can't recall the exact date, but the migration moved four hundred tables to Aurora over one weekend.",
  ]) {
    const r = turnComposition.classify(said);
    assert.equal(r.act, null, `"${said.slice(0, 40)}..." was read as ${r.act}`);
    assert.equal(r.isAnswer, true);
    assert.ok(r.contentWords > 0);
  }
});

test("2.2: the withdrawal trap — 'I don't want to do this manually' is an answer", () => {
  const r = turnComposition.classify(
    "I don't want to do this manually, so I wrote a script that generates the posts each morning."
  );
  assert.equal(r.act, null);
  assert.equal(r.isAnswer, true);
});

test("2.3: one sentence of evidence is enough, however many acts surround it", () => {
  const r = turnComposition.classify(
    "You asked me this before. Can you repeat it? I don't know. We ran the whole campaign on CapCut and Meta Ads."
  );
  assert.equal(r.act, null, "evidence must win over any number of acts");
  assert.equal(r.isAnswer, true);
  assert.match(r.contentText, /CapCut/i);
  // The acts were still SEEN — a caller that wants to know they also asked to repeat can find out.
  assert.ok(r.detectedAct, "the act is still reported, just not honoured");
});

// ---------------------------------------------------------------------------
// 3. The other acts
// ---------------------------------------------------------------------------

test("3.1: a bare repeat request is a repeat, not a decline and not an answer", () => {
  for (const said of ["Can you repeat?", "Sorry, could you repeat that?", "What was the question?"]) {
    const r = turnComposition.classify(said);
    assert.equal(r.act, "repeat", `"${said}" read as ${r.act}`);
    assert.equal(r.isAnswer, false);
  }
});

test("3.2: an already-answered claim is its own act, distinct from a decline", () => {
  const r = turnComposition.classify("You already asked me this. I answered that already.");
  assert.equal(r.act, "already_answered");
  assert.equal(r.isAnswer, false);
});

test("3.3: a decline outranks a repeat request in the same turn", () => {
  // Asking twice to hear it again and then giving up IS giving up. Replaying the question a third
  // time would answer the wrong half of what they said.
  const r = turnComposition.classify("Can you repeat that? Actually, I want to skip this question.");
  assert.equal(r.act, "decline");
});

test("3.4: filler alone is no act at all", () => {
  for (const said of ["Okay.", "Yeah.", "Um.", "That's it."]) {
    assert.equal(turnComposition.classify(said).act, null);
  }
});

// ---------------------------------------------------------------------------
// 4. Sentence-level plumbing
// ---------------------------------------------------------------------------

test("4.1: an unpunctuated 'Actually' run-on is split, or turn 17 cannot be read", () => {
  const parts = turnComposition.sentencesOf("I would like to skip this Actually, not able to no.");
  assert.ok(parts.length >= 2, `expected a split, got ${JSON.stringify(parts)}`);
});

test("4.2: evidence is vocabulary the interview is not about", () => {
  assert.equal(turnComposition.carriesEvidence("you asked me this question before"), false);
  assert.equal(turnComposition.carriesEvidence("this is taking too much of my time"), false);
  assert.equal(turnComposition.carriesEvidence("we ran it on Kafka"), true);
  assert.equal(turnComposition.carriesEvidence("about two thousand a day"), true);
});

test("4.3: apostrophes never decide anything", () => {
  // "didn't" outside the stopword list was on its own enough to make a clause of pure filler read
  // as evidence, which is what kept turn 22 out of reach.
  for (const [a, b] of [["didn't", "didnt"], ["don't", "dont"], ["that's", "thats"], ["I've", "Ive"]]) {
    assert.equal(
      turnComposition.carriesEvidence(`the question I ${a} get`),
      turnComposition.carriesEvidence(`the question I ${b} get`),
      `${a} and ${b} must read the same`
    );
  }
});
