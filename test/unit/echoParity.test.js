// The browser's copy of the echo gate must agree with the server's.
//
// utils/echoAlignment.js and user/src/portal/echoAlignment.js are the same algorithm written
// twice, because the decision has to be made in the browser (only it knows what is coming out of
// the speaker right now) while the server owns the thresholds and has to be able to reason about
// what the browser will do. That duplication is deliberate — and unguarded duplication drifts.
//
// It drifts SILENTLY and in the worst direction. Nothing else in the system would notice if the
// browser's copy started disagreeing: interviews would simply begin cutting off mid-question on
// some devices, or letting the interviewer's own voice into candidates' answers, and the first
// report would be a candidate complaint weeks later. The existing mirrored module
// (portal/endpointing.js) has no such test, which is exactly why this one exists.
//
// This test is the reason a change to one file cannot ship without the other.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const server = require("../../utils/echoAlignment");

const BROWSER_MODULE = pathToFileURL(
  path.join(__dirname, "..", "..", "..", "user", "src", "portal", "echoAlignment.js")
).href;

// Spoken utterances the interviewer really makes: a compiled question, a bank backchannel, and a
// composed answer to a process question.
const SPOKEN = [
  "Tell me about the Kafka migration you led at Zeta, and what your specific role was on that team.",
  "Take your time — I'm here.",
  "Between 2 and 5 more, depending on how the rest goes.",
  "You mentioned you were the only on-call engineer for eighteen months. How was that rota arranged?",
];

// What the microphone might return: pure echo, mixed echo and interruption, clean speech,
// transcription noise, near-misses, and the empty/degenerate cases.
const HEARD = [
  "",
  "and what your specific role was on that team",
  "tell me about the kafka migration",
  "you led at zeta sorry can i stop you there",
  "sorry could i answer that in two parts",
  "you asked about the kafka migration the kafka migration was the second thing we did",
  "that",
  "and",
  "take your time",
  "take your time im here",
  "wait one moment please",
  "and what your specific rule was on that team",
  "between 2 and 5 more",
  "how was that rota arranged",
  "i was the only on call engineer for eighteen months yes",
  "um",
  "no i think we should talk about something else entirely",
  "the",
];

const RATIOS = [undefined, 0, 0.25, 0.5, 0.9, 1];

test("the browser's echo gate reaches the same verdict as the server's, case for case", async () => {
  const browser = await import(BROWSER_MODULE);
  let compared = 0;

  for (const spokenText of ["", ...SPOKEN]) {
    for (const transcript of HEARD) {
      for (const spokenRatio of RATIOS) {
        const opts = { spokenText, spokenRatio, policy: server.DEFAULTS };
        const s = server.classify(transcript, opts);
        const b = browser.classifyEcho(transcript, opts);
        const where = `heard=${JSON.stringify(transcript)} over=${JSON.stringify(spokenText.slice(0, 30))} ratio=${spokenRatio}`;

        assert.equal(b.verdict, s.verdict, `verdict disagrees — ${where}`);
        // The residue is what becomes the candidate's answer on a barge-in. A disagreement here
        // puts different words in the transcript depending on which side you ask.
        assert.equal(b.residue, s.residue, `residue disagrees — ${where}`);
        assert.equal(b.novelRun, s.novelRun, `novelRun disagrees — ${where}`);
        compared += 1;
      }
    }
  }

  assert.ok(compared > 500, `expected a real corpus, compared only ${compared} cases`);
});

test("both copies carry the same defaults, so a threshold change cannot land on one side only", async () => {
  const browser = await import(BROWSER_MODULE);
  assert.deepEqual(browser.ECHO_DEFAULTS, server.DEFAULTS);
});

test("the browser applies server-supplied thresholds rather than its own", async () => {
  const browser = await import(BROWSER_MODULE);
  const spokenText = SPOKEN[0];
  const transcript = "you led at zeta sorry can i";

  // Three novel words ("sorry can i") is a barge-in at the default, and must not be at a stricter
  // threshold — which is what proves the number came from the policy and not from a local constant.
  const strict = { spokenText, spokenRatio: 1, policy: { ...server.DEFAULTS, minNovelRun: 8 } };
  assert.equal(browser.classifyEcho(transcript, strict).verdict, "echo");
  assert.equal(server.classify(transcript, strict).verdict, "echo");

  const normal = { spokenText, spokenRatio: 1, policy: server.DEFAULTS };
  assert.equal(browser.classifyEcho(transcript, normal).verdict, "speech");
  assert.equal(server.classify(transcript, normal).verdict, "speech");
});
