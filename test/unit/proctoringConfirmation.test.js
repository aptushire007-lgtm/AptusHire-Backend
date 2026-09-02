// Acceptance gates for confirmed-episode proctoring capture.
//
// The defect this suite locks down: the browser used to report `face_absent` on a SINGLE dropped
// frame, and the server scored it as a measurement of the candidate. A webcam that lost the face
// four times over a twenty-minute interview — dim room, glasses glare, a downward glance — pushed
// a candidate into the "medium risk" band on nothing but detector noise, and the evidence clip
// attached to that flag visibly showed them sitting at their desk.
//
// The rules encoded here:
//   - a detector's failure and a candidate's absence are DIFFERENT propositions, and only one of
//     them is ever scored;
//   - recording-condition events are still SURFACED (a recruiter must not read "we could not see"
//     as "nothing happened") while contributing exactly zero risk;
//   - the measurement that triggered a clip travels with the clip, allow-listed and clamped;
//   - the browser reports word counts, the server decides what they mean;
//   - a client can never inject a server-derived high-severity type.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const proctoring = require("../../utils/proctoring");
const evidenceClipService = require("../../services/evidenceClipService");

// ---------------------------------------------------------------------------
// 1. A detector's failure is not a candidate's behaviour
// ---------------------------------------------------------------------------

test("1.1: detector_uncertain exists, is weightless, and is structurally excluded from risk", () => {
  const def = proctoring.EVENT_TYPES.detector_uncertain;
  assert.ok(def, "detector_uncertain must be a known type — it has to be reportable");
  assert.equal(def.weight, 0);
  assert.equal(def.cap, 0);
  assert.ok(proctoring.NON_SCORING_TYPES.has("detector_uncertain"));

  // Even a pathological count cannot move the score off zero.
  const { riskScore, riskBand } = proctoring.computeRisk({ detector_uncertain: 500 });
  assert.equal(riskScore, 0);
  assert.equal(riskBand, "low");
});

test("1.2: exclusion is structural, not just a zero weight", () => {
  // Simulate a future edit that gives the type a weight by mistake. computeRisk skips the type by
  // name, so the mistake cannot silently start scoring our own camera trouble as misconduct.
  const def = proctoring.EVENT_TYPES.detector_uncertain;
  const original = def.weight;
  def.weight = 25;
  try {
    assert.equal(proctoring.computeRisk({ detector_uncertain: 4 }).riskScore, 0);
  } finally {
    def.weight = original;
  }
});

test("1.3: an unclear camera is still SHOWN to the recruiter, marked unscored", () => {
  const rows = proctoring.breakdown({ detector_uncertain: 3, tab_switch: 1 });
  const row = rows.find((r) => r.type === "detector_uncertain");
  assert.ok(row, "the row must appear — silence would render 'unobserved' as 'nothing happened'");
  assert.equal(row.count, 3);
  assert.equal(row.points, 0);
  assert.equal(row.scored, false);
  assert.match(row.benignExplanation, /not the candidate/i);

  const scoredRow = rows.find((r) => r.type === "tab_switch");
  assert.equal(scoredRow.scored, true);
});

test("1.4: the four confirmed false-positive absences that used to cost a band still cost one — but only when confirmed", () => {
  // This is the pre-existing weighting, unchanged: real, confirmed absence is still medium.
  // What changed is what qualifies as "real" — the client now requires 4 continuous seconds AND a
  // strong prior detection, and routes everything else to detector_uncertain.
  assert.equal(proctoring.computeRisk({ face_absent: 4 }).riskBand, "medium");
  // The same four events, classified honestly as detector trouble, cost nothing.
  assert.equal(proctoring.computeRisk({ detector_uncertain: 4 }).riskBand, "low");
});

// ---------------------------------------------------------------------------
// 2. Gaze direction survives as an enum, never as client text
// ---------------------------------------------------------------------------

test("2.1: gaze direction is preserved — 'down' and 'side' are different findings", () => {
  assert.deepEqual(proctoring.sanitizeMeta("gaze_away", { direction: "down" }), { direction: "down" });
  assert.deepEqual(proctoring.sanitizeMeta("gaze_away", { direction: "side" }), { direction: "side" });
});

test("2.2: any other direction value is dropped, not passed through to the report", () => {
  assert.equal(proctoring.sanitizeMeta("gaze_away", { direction: "<script>alert(1)</script>" }), undefined);
  assert.equal(proctoring.sanitizeMeta("gaze_away", { direction: "AWAY" }), undefined);
  assert.equal(proctoring.sanitizeMeta("gaze_away", { direction: 12 }), undefined);
});

// ---------------------------------------------------------------------------
// 3. Diarization: the browser measures, the server judges
// ---------------------------------------------------------------------------

test("3.1: a scattering of mislabelled words is NOT a second speaker", () => {
  // Diarization routinely mislabels the odd word. A handful must never raise a high-severity flag.
  assert.equal(proctoring.detectSecondSpeaker({ distinctSpeakers: 2, secondaryWords: 1 }), null);
  assert.equal(proctoring.detectSecondSpeaker({ distinctSpeakers: 2, secondaryWords: 7 }), null);
});

test("3.2: a substantial run of non-dominant speech is a second speaker", () => {
  const hit = proctoring.detectSecondSpeaker({ distinctSpeakers: 2, secondaryWords: 40 });
  assert.deepEqual(hit, { distinctSpeakers: 2, secondaryWords: 40 });
});

test("3.3: one speaker is never a second speaker, however many words they said", () => {
  assert.equal(proctoring.detectSecondSpeaker({ distinctSpeakers: 1, secondaryWords: 500 }), null);
});

test("3.4: malformed or absent reports are ignored rather than guessed at", () => {
  assert.equal(proctoring.detectSecondSpeaker(undefined), null);
  assert.equal(proctoring.detectSecondSpeaker(null), null);
  assert.equal(proctoring.detectSecondSpeaker("2"), null);
  assert.equal(proctoring.detectSecondSpeaker({ distinctSpeakers: "many", secondaryWords: 40 }), null);
});

test("3.5: second_speaker is weighted exactly as strongly as an identity mismatch", () => {
  // Someone else speaking the answer IS the answer not being the candidate's — the most direct
  // evidence available to this platform, and stronger than anything a camera can establish. It is
  // pinned to identity_mismatch rather than to an absolute band so the two cannot drift apart.
  const second = proctoring.EVENT_TYPES.second_speaker;
  const identity = proctoring.EVENT_TYPES.identity_mismatch;
  assert.equal(second.severity, "high");
  assert.equal(second.severity, identity.severity);
  assert.equal(second.weight, identity.weight);
  assert.equal(
    proctoring.computeRisk({ second_speaker: 1 }).riskScore,
    proctoring.computeRisk({ identity_mismatch: 1 }).riskScore
  );
  // One occurrence is a prompt to review (medium); a repeat across answers is not.
  assert.equal(proctoring.computeRisk({ second_speaker: 1 }).riskBand, "medium");
  assert.equal(proctoring.computeRisk({ second_speaker: 2 }).riskBand, "high");
});

test("3.6: even a high-severity flag ships with its benign explanation", () => {
  // A television or a household interruption produces the same measurement. The recruiter is told
  // so on the same row — the flag is a prompt to listen, never a conclusion.
  assert.match(proctoring.benignExplanationOf("second_speaker"), /television|conversation|interruption/i);
});

test("3.7: second-speaker meta is numeric and clamped", () => {
  const meta = proctoring.sanitizeMeta("second_speaker", { secondaryWords: 1e9, distinctSpeakers: 99 });
  assert.equal(meta.secondaryWords, 9999);
  assert.equal(meta.distinctSpeakers, 10);
});

// ---------------------------------------------------------------------------
// 4. The trigger travels with the clip — allow-listed and clamped
// ---------------------------------------------------------------------------

test("4.1: the new confirmed episode types qualify for capture", () => {
  // gaze_away used to be missing from the allow-list: the client could trigger it and the upload
  // would 400 into a swallowed catch — a capture that silently never existed.
  for (const type of ["multi_face", "face_absent", "gaze_away", "identity_mismatch", "detector_uncertain"]) {
    assert.ok(evidenceClipService.QUALIFYING_EVENTS.has(type), `${type} must qualify`);
  }
});

test("4.2: the measurement that fired the rule is preserved", () => {
  const t = evidenceClipService.sanitizeTrigger({
    rule: "4 consecutive seconds with no face detected",
    lastDetectorScore: 0.918273,
    lastFaceFrameRatio: 0.0421,
    lastFaceAtEdge: false,
    classified: "face_absent",
  });
  assert.equal(t.rule, "4 consecutive seconds with no face detected");
  assert.equal(t.lastDetectorScore, 0.918); // rounded, not raw
  assert.equal(t.lastFaceAtEdge, false);
  assert.equal(t.classified, "face_absent");
});

test("4.3: a JSON string survives the multipart round trip", () => {
  const t = evidenceClipService.sanitizeTrigger(JSON.stringify({ rule: "x", faceCount: 2 }));
  assert.deepEqual(t, { rule: "x", faceCount: 2 });
});

test("4.4: free-form client fields never reach the report or the PDF", () => {
  const t = evidenceClipService.sanitizeTrigger({
    rule: "ok",
    note: "<img src=x onerror=alert(1)>",
    verdict: "CHEATING",
    recommendation: "reject",
  });
  assert.deepEqual(Object.keys(t), ["rule"]);
});

test("4.5: an over-long rule is truncated rather than rejected", () => {
  const t = evidenceClipService.sanitizeTrigger({ rule: "z".repeat(500) });
  assert.equal(t.rule.length, 160);
});

test("4.6: garbage in gives nothing out — never a half-built object", () => {
  assert.equal(evidenceClipService.sanitizeTrigger(undefined), undefined);
  assert.equal(evidenceClipService.sanitizeTrigger("not json"), undefined);
  assert.equal(evidenceClipService.sanitizeTrigger([1, 2, 3]), undefined);
  assert.equal(evidenceClipService.sanitizeTrigger({ unknown: true }), undefined);
});

test("4.7: the classification is an enum — a client cannot invent a verdict word", () => {
  assert.equal(evidenceClipService.sanitizeTrigger({ classified: "definitely_cheating" }), undefined);
});
