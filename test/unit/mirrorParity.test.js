// The browser's copies of the turn-taking rules must agree with the server's.
//
// Three modules are written twice, on purpose, for the same reason echoAlignment is: the decision
// has to be made in the browser (only it knows, in real time, when the silence started and what
// was just said) while the server owns the thresholds, the trigger lists and the wording. That
// duplication is deliberate. Unguarded duplication drifts.
//
// It drifts SILENTLY and in the worst direction. Nothing else in the system would notice:
//
//   - endpointing — the browser starts cutting candidates off mid-thought, or leaving finished
//     answers in silence. The server's own record of WHY the turn ended would say something
//     different from what the candidate experienced, so even the complaint would be unfalsifiable.
//   - dialogueActs — "I don't know" stops being read as a decline and gets scored as an answer,
//     or a phrase buried in a real answer starts ending turns.
//   - finishIntent — "that's my answer" stops working, and the candidate sits through a countdown
//     they cannot see after saying they were done.
//
// echoAlignment got a parity test the day it was written (echoParity.test.js). These three did
// not, and they are older. This is that test.
//
// It compares BEHAVIOUR, case by case, not source text — the two copies are allowed to be written
// differently, they are not allowed to decide differently.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const serverEndpointing = require("../../utils/endpointing");
const serverDialogueActs = require("../../utils/dialogueActs");
const serverFinish = require("../../utils/finishIntent");

const browserUrl = (file) =>
  pathToFileURL(path.join(__dirname, "..", "..", "..", "user", "src", "portal", file)).href;

// Real shapes of spontaneous speech: trailing conjunctions, fillers, completed sentences, the
// short answers that are hardest to classify, and the degenerate cases.
const TRANSCRIPTS = [
  "",
  "   ",
  "um",
  "so we moved the ingestion pipeline onto Kafka because",
  "so we moved the ingestion pipeline onto Kafka because the batch job kept falling over.",
  "I led that migration across four services over about six months and it went well.",
  "yes",
  "yes.",
  "I think so",
  "we used Redis for the hot path and Postgres for everything else, sort of",
  "and then",
  "I don't know",
  "I don't know the exact number, but we ran three brokers and the lag stayed under forty ms",
  "can we skip this one",
  "give me a second",
  "hold on, one moment",
  "I want to stop the interview",
  "that's my answer",
  "we ran three brokers across two availability zones and the lag stayed low, that's my answer",
  "that's it",
  "sorry could you repeat that",
  "no",
  "yeah go ahead",
  "let me think",
  "the thing is, and this is the part that mattered, we could not",
];

// Energy envelopes: none at all, too few samples to have an opinion, falling away (a finished
// sentence), and rising (someone gathering steam).
const ENERGY = [
  undefined,
  [],
  [0.05, 0.06, 0.05],
  [...Array(12).fill(0.08), ...Array(6).fill(0.01)],
  [...Array(12).fill(0.02), ...Array(6).fill(0.09)],
  [...Array(20).fill(0.06)],
];

test("the browser's endpointing reaches the same verdict as the server's, case for case", async () => {
  const browser = await import(browserUrl("endpointing.js"));
  const policy = serverEndpointing.clientPolicy().endpointing;
  let compared = 0;

  for (const transcript of TRANSCRIPTS) {
    for (const energy of ENERGY) {
      const s = serverEndpointing.classify(transcript, { energy, policy });
      const b = browser.classify(transcript, { energy, policy });
      const where = `heard=${JSON.stringify(transcript)} energy=${energy ? energy.length : "none"}`;

      // The verdict decides whether the candidate is interrupted. The WAIT decides how long they
      // are given. A disagreement in either is a candidate having a different interview depending
      // on which side of the wire you ask.
      assert.equal(b.state, s.state, `state disagrees — ${where}`);
      assert.equal(b.waitMs, s.waitMs, `waitMs disagrees — ${where}`);
      assert.equal(b.reason, s.reason, `reason disagrees — ${where}`);
      compared += 1;
    }
  }
  assert.ok(compared >= 100, `expected a real corpus, compared only ${compared}`);
});

test("the two endpointing copies carry the same defaults and honour server thresholds", async () => {
  const browser = await import(browserUrl("endpointing.js"));
  // A server that sends nothing must not produce two different interviewers. The browser's own
  // fallback constants have to equal the server's defaults, or an older backend silently gives
  // some candidates a more patient interviewer than others.
  assert.deepEqual(browser.normalizeEndpointing(undefined), serverEndpointing.DEFAULTS);

  // And the numbers must come from the policy, not from a local constant — which is the failure
  // mode a "same defaults" check alone would miss entirely.
  const strict = { completeWaitMs: 111, ambiguousWaitMs: 222, holdingWaitMs: 333, minCompleteWords: 40 };
  const text = "I led that migration across four services over about six months and it went well.";
  assert.equal(browser.classify(text, { policy: strict }).waitMs, serverEndpointing.classify(text, { policy: strict }).waitMs);
  assert.equal(browser.classify(text, { policy: strict }).state, "ambiguous", "minCompleteWords came from the policy");
});

test("a sentence ending on a preposition waits, even when it is finished — on both sides", () => {
  // "…the batch job kept falling over." is a complete sentence whose last word is in the
  // holding list, so it is classified `holding` and given the long window rather than the short
  // one. Found by writing the test above, and left alone deliberately: both copies agree, and the
  // error is in the safe direction. Waiting too long feels slow; ending early destroys evidence
  // the candidate was still giving. Pinned here so it reads as a decision rather than a bug the
  // next time somebody trips over it.
  const text = "so we moved the ingestion pipeline onto Kafka because the batch job kept falling over.";
  const s = serverEndpointing.classify(text, { policy: serverEndpointing.DEFAULTS });
  assert.equal(s.state, "holding");
  assert.equal(s.reason, "trails_mid_thought");
});

test("the browser's dialogue-act detection matches the server's, case for case", async () => {
  const browser = await import(browserUrl("dialogueActs.js"));
  const policy = browser.normalizeDialogueActs(serverDialogueActs.clientPolicy().dialogueActs);

  for (const transcript of TRANSCRIPTS) {
    const s = serverDialogueActs.detect(transcript);
    const b = browser.detectAct(transcript, policy);
    const where = `heard=${JSON.stringify(transcript)}`;

    // `honour` is the one that matters: it decides whether a turn is ended, an answer discarded,
    // or an interview stopped. `act` has to agree too, or the two sides would take different
    // actions on the same words.
    assert.equal(b.honour, s.honour, `honour disagrees — ${where}`);
    assert.equal(b.act, s.act, `act disagrees — ${where}`);
    if (s.honour) assert.equal(b.matchedTrigger, s.matchedTrigger, `trigger disagrees — ${where}`);
  }
});

test("the browser's yes/no reading matches the server's, and unclear is never yes", async () => {
  const browser = await import(browserUrl("dialogueActs.js"));
  const policy = browser.normalizeDialogueActs(serverDialogueActs.clientPolicy().dialogueActs);

  const replies = [
    "yes", "yeah", "yep", "no", "nope", "no thanks", "not really", "carry on",
    "sorry what", "I mean yes but", "um", "", "yes please end it",
    "no wait I didn't mean that",
  ];
  for (const reply of replies) {
    const s = serverDialogueActs.detectConfirmation(reply);
    const b = browser.detectConfirmation(reply, policy);
    assert.equal(b, s, `confirmation disagrees — ${JSON.stringify(reply)}`);
    // The asymmetry both copies must preserve: only an explicit yes ends an interview. Anything
    // unrecognisable continues it, because continuing costs one more question and stopping costs
    // the job.
    if (b !== "yes") assert.notEqual(b, "yes");
  }
});

test("the browser's finish detection matches the server's, case for case", async () => {
  const browser = await import(browserUrl("endpointing.js"));
  const p = serverFinish.clientPolicy();
  const opts = {
    triggers: p.finishTriggers,
    minAnswerWords: p.finishMinAnswerWords,
    maxTrailingWords: p.finishMaxTrailingWords,
  };

  for (const transcript of TRANSCRIPTS) {
    const s = serverFinish.detect(transcript, opts);
    const b = browser.detectFinish(transcript, opts);
    const where = `heard=${JSON.stringify(transcript)}`;
    assert.equal(b.honour, s.honour, `honour disagrees — ${where}`);
    assert.equal(b.matched, s.matched, `matched disagrees — ${where}`);
  }

  // The guard both sides have to keep: "that's it" alone is a sentence still forming, not a
  // hand-back. Only the tail of a substantive answer ends a turn.
  assert.equal(browser.detectFinish("that's it", opts).honour, false);
  assert.equal(serverFinish.detect("that's it", opts).honour, false);
});

test("no triggers from the server means the feature is OFF, on both sides", async () => {
  // The rule every mirrored module here follows: what counts as "I want to stop" is server-owned,
  // and a client that invented its own would be the worst thing in this codebase. An older or
  // misconfigured backend that sends nothing must produce an interviewer that understands less —
  // never one that guesses.
  const acts = await import(browserUrl("dialogueActs.js"));
  const ep = await import(browserUrl("endpointing.js"));
  const empty = acts.normalizeDialogueActs(undefined);

  assert.deepEqual(empty.withdrawTriggers, []);
  assert.deepEqual(empty.declineTriggers, []);
  assert.equal(acts.detectAct("I want to stop the interview", empty).honour, false);
  assert.equal(acts.detectConfirmation("yes", empty), null);
  assert.equal(ep.detectFinish("that is my answer and I am done now for sure", { triggers: [] }).honour, false);
});
