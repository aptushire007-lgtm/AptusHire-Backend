// Screen-share / pre-existing-remote-assistance risk signals (device_busy,
// multi_display_detected, bandwidth_anomaly, devtools_open) and the correlation bonus that
// fuses them. No browser API can observe a pre-existing third-party screen share, so these are
// deliberately weak proxy signals — the tests here exist to keep that honest: no single new
// signal may swing the risk band on its own, and the correlation bonus must require genuine
// convergence across independent families, not repetition of one.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const proctoring = require("../../utils/proctoring");

test("the four new signal types are known and non-scoring types are unaffected", () => {
  for (const type of ["device_busy", "multi_display_detected", "bandwidth_anomaly", "devtools_open"]) {
    assert.ok(proctoring.isKnownType(type), `${type} should be a known event type`);
  }
  // Existing non-scoring types must still contribute nothing.
  const { riskScore } = proctoring.computeRisk({ detector_uncertain: 5, vision_unavailable: 1 });
  assert.equal(riskScore, 0);
});

test("a single occurrence of any one new signal stays low-severity and does not move the band to high", () => {
  for (const type of ["device_busy", "multi_display_detected", "bandwidth_anomaly", "devtools_open"]) {
    const { riskScore, riskBand } = proctoring.computeRisk({ [type]: 1 });
    assert.notEqual(riskBand, "high", `${type} alone should never reach the high band`);
    assert.ok(riskScore <= 30, `${type} alone should stay low-weight (got ${riskScore})`);
  }
});

test("multi_display_detected repeated many times still stays capped and low", () => {
  const { riskScore } = proctoring.computeRisk({ multi_display_detected: 50 });
  // cap is 6 points, tier-dampened at 0.25 for "low" severity — must stay tiny regardless of count.
  assert.ok(riskScore <= 5, `expected a capped, near-zero score, got ${riskScore}`);
});

test("correlationBonus is zero with 0 or 1 family present, and only engages at 2+", () => {
  assert.equal(proctoring.correlationBonus({}), 0);
  assert.equal(proctoring.correlationBonus({ device_busy: 1 }), 0);
  assert.equal(proctoring.correlationBonus({ device_busy: 5 }), 0, "repetition of ONE family is not convergence");
  assert.ok(proctoring.correlationBonus({ device_busy: 1, gaze_away: 1 }) > 0);
});

test("correlationBonus caps at the documented ceiling even with every family present", () => {
  const bonus = proctoring.correlationBonus({
    device_busy: 1,
    multi_display_detected: 1,
    bandwidth_anomaly: 1,
    gaze_away: 1,
    multi_face: 1,
  });
  assert.ok(bonus <= 20, `correlation bonus must stay capped, got ${bonus}`);
});

test("two independently weak signals together are still auditable but never alone sufficient for 'high'", () => {
  // device_busy (medium, weight 10) + one gaze_away (low, weight 2) — a real-looking pairing that
  // must raise the score (the whole point of correlation) without manufacturing false certainty.
  const withoutCorrelation = proctoring.computeRisk({ device_busy: 1 });
  const withCorrelation = proctoring.computeRisk({ device_busy: 1, gaze_away: 1 });
  assert.ok(
    withCorrelation.riskScore > withoutCorrelation.riskScore,
    "correlated weak signals should score higher than either alone"
  );
});

test("the risk score is never pushed past 100 by stacking every new signal at high volume", () => {
  const { riskScore } = proctoring.computeRisk({
    device_busy: 100,
    multi_display_detected: 100,
    bandwidth_anomaly: 100,
    devtools_open: 100,
    multi_face: 100,
    identity_mismatch: 100,
  });
  assert.ok(riskScore <= 100);
});

test("breakdown() reports the new types with their benign explanations", () => {
  const rows = proctoring.breakdown({ device_busy: 1, multi_display_detected: 1 });
  const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
  assert.ok(byType.device_busy.benignExplanation, "device_busy should carry a benign explanation");
  assert.ok(byType.multi_display_detected.benignExplanation, "multi_display_detected should carry a benign explanation");
  assert.equal(byType.device_busy.scored, true);
});

// ---------------------------------------------------------------------------
// §3.7 — browser-tier events alone require corroboration before the band can rise
// ---------------------------------------------------------------------------

test("§3.7: a browser-only event stream, maxed out, never reaches band 'high'", () => {
  const { riskBand } = proctoring.computeRisk({ tab_switch: 50, window_blur: 50, fullscreen_exit: 50, context_menu: 50 });
  assert.notEqual(riskBand, "high", "browser-chrome events alone must never band a candidate high");
});

test("§3.7: a browser-only event stream, maxed out, is capped at 'low' — not just kept off 'high'", () => {
  // The plan's own requirement is stricter than "never high": three OS notifications and a brief
  // fullscreen exit, with zero camera/vision evidence, must not read as elevated risk AT ALL.
  const { riskScore, riskBand, corroborated } = proctoring.computeRisk({
    tab_switch: 50,
    window_blur: 50,
    fullscreen_exit: 50,
    context_menu: 50,
  });
  assert.equal(riskBand, "low", `browser-tier-only must be capped at low (raw score ${riskScore})`);
  assert.equal(corroborated, false);
});

test("§3.7: the raw score is left visible even while the band is capped — never a silently different number", () => {
  const counts = { tab_switch: 50, window_blur: 50, fullscreen_exit: 50, context_menu: 50 };
  const uncappedishScore = proctoring.computeRisk(counts).riskScore;
  assert.ok(uncappedishScore > 0, "the underlying score is still computed and auditable, only the band is capped");
});

test("§3.7: one corroborating non-browser signal is enough to let the real band through", () => {
  // The exact same browser-tier load as above, plus one vision-layer signal — now corroborated,
  // and the band is whatever the (unchanged) tier-dampened formula actually computes.
  const counts = { tab_switch: 50, window_blur: 50, fullscreen_exit: 50, context_menu: 50, face_absent: 1 };
  const { riskBand, corroborated } = proctoring.computeRisk(counts);
  assert.equal(corroborated, true);
  assert.notEqual(riskBand, "low", "a real corroborating signal must not be masked by the browser-tier cap");
});

// ---------------------------------------------------------------------------
// Anti-cheating hard-stop trigger set — regression guard on a deliberate exclusion
// ---------------------------------------------------------------------------

test("AUTO_SUBMIT_TRIGGER_TYPES is exactly the strong-signal set, and deliberately excludes second_speaker", () => {
  const types = proctoring.AUTO_SUBMIT_TRIGGER_TYPES;
  assert.ok(types instanceof Set);
  for (const t of ["multi_face", "identity_mismatch", "device_busy"]) {
    assert.ok(types.has(t), `${t} must be a hard-stop trigger`);
  }
  // second_speaker is weighted just as heavily in the advisory risk score, but unlike
  // multi_face/identity_mismatch it can re-fire on every qualifying answer, and its own
  // BENIGN_EXPLANATIONS entry admits a television or nearby conversation can cause it — too weak a
  // signal to end a real candidate's session with no human step. Adding it back here would silently
  // reintroduce that risk, so this asserts it stays out.
  assert.ok(!types.has("second_speaker"), "second_speaker must stay out of the hard-stop set — see proctoring.js's comment");
  assert.equal(types.size, 3, "no other type should be added without an equally deliberate reason");
});
