// Semantic endpointing — the fix for the single loudest piece of candidate feedback:
// "don't interrupt in between."
//
// That was never a designed interjection. It was a flat timer ending the turn while the
// candidate was still thinking. The timer had been raised twice (2000 → 3200) chasing it, which
// only traded one failure for another: candidates who HAD finished then sat in silence for over
// three seconds waiting for a countdown they could not see.
//
// The gates here are the two failure modes, and they are not symmetric:
//   - ending a turn early DESTROYS evidence the candidate was mid-answer  → must never happen
//   - waiting too long merely feels slow                                  → acceptable
// So every ambiguous case must wait. That asymmetry is the property under test.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const endpointing = require("../../utils/endpointing");
const finishIntent = require("../../utils/finishIntent");
const personaService = require("../../services/personaService");

// A falling envelope (voice trailing off) and a flat one (stopped abruptly, mid-thought).
const FALLING = [...Array(10).fill(0.30), ...Array(5).fill(0.05)];
const FLAT = Array(15).fill(0.30);
const RISING = [...Array(10).fill(0.10), ...Array(5).fill(0.40)];

// ---------------------------------------------------------------------------
// 1. Mid-thought must never end the turn
// ---------------------------------------------------------------------------

test("EP1.1: GATE — a transcript trailing mid-thought is never treated as finished", () => {
  const midThought = [
    "So we started with a monolith and",
    "The tricky part was that the queue would back up because",
    "I looked at three options, but",
    "We deployed it to staging first and then",
    "The main bottleneck turned out to be the",
    "It was mostly a question of",
    "I'd probably reach for Redis here, or",
    "We fixed it by adding an index to",
  ];
  for (const text of midThought) {
    const v = endpointing.classify(text, { energy: FALLING });
    assert.equal(v.state, "holding", `must keep listening: ${JSON.stringify(text)}`);
    assert.ok(v.waitMs >= 4000, "and must wait generously");
  }
});

test("EP1.2: GATE — hesitation sounds hold the floor, however long the pause", () => {
  for (const text of ["We scaled it horizontally, um", "I think the answer is uh", "That would be, hmm"]) {
    assert.equal(endpointing.classify(text, { energy: FALLING }).state, "holding", text);
  }
});

test("EP1.3: GATE — a rising voice is someone making another point, not signing off", () => {
  const v = endpointing.classify("We rewrote the ingestion path and cut latency by half", { energy: RISING });
  assert.equal(v.state, "holding");
  assert.equal(v.reason, "energy_rising");
});

test("EP1.4: GATE — nothing said yet never ends a turn", () => {
  assert.equal(endpointing.classify("", { energy: FALLING }).state, "holding");
  assert.equal(endpointing.classify("   ", {}).state, "holding");
  assert.equal(endpointing.classify(null, {}).state, "holding");
});

test("EP1.5: multi-word tails hold the floor even when the last token looks harmless", () => {
  for (const text of ["We used a queue, sort of", "It was fine, you know", "Let me think"]) {
    assert.equal(endpointing.isHolding(text), true, text);
  }
});

// ---------------------------------------------------------------------------
// 2. A finished answer gets a prompt response
// ---------------------------------------------------------------------------

test("EP2.1: a completed sentence with the voice falling away responds in under a second", () => {
  const v = endpointing.classify(
    "We moved the whole ingestion pipeline onto Kafka and it cut our end-to-end latency roughly in half.",
    { energy: FALLING }
  );
  assert.equal(v.state, "complete");
  assert.ok(v.waitMs < 1000, `a finished answer must not sit in silence (got ${v.waitMs}ms)`);
  assert.equal(v.reason, "sentence_end_falling_energy");
});

test("EP2.2: the old flat behaviour is strictly beaten — finished answers wait far less than 3200ms", () => {
  const v = endpointing.classify(
    "So in the end we settled on optimistic locking, and that removed the contention entirely.",
    { energy: FALLING }
  );
  assert.ok(v.waitMs < 3200, "the whole point of the change");
});

test("EP2.3: a short answer is ambiguous however it ends — 'Yes.' is a sentence, not an answer", () => {
  const v = endpointing.classify("Yes.", { energy: FALLING });
  assert.equal(v.state, "ambiguous");
  assert.equal(v.reason, "too_short_to_be_sure");
  assert.ok(v.waitMs > endpointing.DEFAULTS.completeWaitMs, "give them room to continue");
});

test("EP2.4: a complete-looking answer with no terminal punctuation waits rather than guesses", () => {
  const v = endpointing.classify(
    "We migrated the service across three regions and rebuilt the deployment pipeline around it",
    { energy: FLAT }
  );
  assert.equal(v.state, "ambiguous");
  assert.ok(v.waitMs > endpointing.DEFAULTS.completeWaitMs);
});

test("EP2.5: missing energy samples degrade to the text alone, never to a crash or a cut-off", () => {
  const v = endpointing.classify("That is how we solved the caching problem in the end.", { energy: [] });
  assert.ok(["complete", "ambiguous"].includes(v.state));
  assert.equal(endpointing.energyTrend(undefined), null);
  assert.equal(endpointing.energyTrend([0.1, 0.2]), null, "too few samples to draw a trend from");
});

test("EP2.6: the energy trend distinguishes trailing off from stopping abruptly", () => {
  assert.equal(endpointing.energyTrend(FALLING), "falling");
  assert.equal(endpointing.energyTrend(FLAT), "flat");
  assert.equal(endpointing.energyTrend(RISING), "rising");
});

// ---------------------------------------------------------------------------
// 3. "That's my answer" — the explicit hand-back
// ---------------------------------------------------------------------------

test("EP3.1: an explicit finish at the end of a real answer is honoured", () => {
  const d = finishIntent.detect(
    "We sharded by tenant id and moved the hot tables onto their own cluster, so that's my answer."
  );
  assert.equal(d.matched, true);
  assert.equal(d.honour, true);
});

test("EP3.2: GATE — a finish phrase with no answer in front of it is NOT a hand-back", () => {
  // Far more likely to be a sentence still forming: "that's it — the thing that broke was…"
  const d = finishIntent.detect("That's it");
  assert.equal(d.matched, true);
  assert.equal(d.honour, false, "ending here would discard the answer they were about to give");
});

test("EP3.3: GATE — a finish phrase followed by more talking is not the end of the turn", () => {
  const d = finishIntent.detect(
    "We rebuilt the indexer and that's about it, although actually the harder part was the backfill " +
      "which took another three weeks of careful batching work"
  );
  assert.equal(d.honour, false, "they carried on — the turn had not ended");
});

test("EP3.4: the candidate's own words are never stripped from their answer", () => {
  // Unlike a repeat request (which was never part of the answer), this is something they said in
  // the interview. Tidying the record is not this system's call.
  const text = "We used a write-through cache in front of Postgres and invalidated on write, so yeah that's it.";
  const d = finishIntent.detect(text);
  assert.equal(d.honour, true);
  assert.equal(d.remainder, undefined, "detect() returns no rewritten transcript, by design");
});

test("EP3.5: ordinary answers containing similar words do not end the turn", () => {
  const notFinishing = [
    "The next question in the survey asked about latency, which we had already instrumented well.",
    "I'm done with the migration work now but the observability piece is still ongoing and needs care.",
  ];
  for (const text of notFinishing) {
    const d = finishIntent.detect(text);
    assert.equal(d.honour, false, `must not end the turn: ${text}`);
  }
});

test("EP3.6: 'that is all' and 'I have completed my answer' are honoured at the tail of a real answer", () => {
  const a = finishIntent.detect(
    "We split the monolith along the order and inventory boundaries and stood up a message queue " +
      "between them, that is all."
  );
  assert.equal(a.honour, true);

  const b = finishIntent.detect(
    "We split the monolith along the order and inventory boundaries and stood up a message queue " +
      "between them. I have completed my answer."
  );
  assert.equal(b.honour, true);
});

test("EP3.7: the bare word 'done' is honoured at the tail of a real answer, but not mid-sentence", () => {
  const tail = finishIntent.detect(
    "We split the monolith along the order and inventory boundaries and stood up a message queue " +
      "between them, done."
  );
  assert.equal(tail.honour, true);

  const midSentence = finishIntent.detect(
    "The migration is done, and then we still had to backfill three years of historical records " +
      "before the new pipeline could take over."
  );
  assert.equal(midSentence.honour, false, "trailing words after 'done' mean the turn had not ended");
});

// ---------------------------------------------------------------------------
// 4. Policy plumbing — the browser detects, the server decides the numbers
// ---------------------------------------------------------------------------

test("EP4.1: the endpointing policy and finish triggers ship with the streaming credential", () => {
  const policy = personaService.conversationPolicy({ patience: {} });
  assert.ok(policy.endpointing, "the browser is told the windows, never invents them");
  assert.ok(policy.endpointing.completeWaitMs > 0);
  assert.ok(policy.endpointing.holdingWaitMs > policy.endpointing.completeWaitMs, "mid-thought waits longer than finished");
  assert.ok(Array.isArray(policy.finishTriggers) && policy.finishTriggers.length > 0);
  assert.ok(policy.finishMinAnswerWords > 0, "and the safety rule that stops a fragment ending a turn");
});

test("EP4.2: the persona's patience still applies alongside endpointing, not instead of it", () => {
  const policy = personaService.conversationPolicy({ patience: { initialSilenceMs: 9000 } });
  assert.equal(policy.initialSilenceMs, 9000, "a tenant can still make the interviewer more patient");
  assert.ok(policy.endpointing.holdingWaitMs > 0);
});

test("EP4.3: BIAS GATE — the end-of-turn reason is a condition of the interview, not a signal", () => {
  // Pacing tracks nerves, accent and connection quality far more closely than competence. The
  // classifier's output must never appear in anything a scorer reads — it is recorded on the
  // answer turn purely so a disputed "it cut me off" is checkable.
  const v = endpointing.classify("We finished the rollout last quarter and it has been stable since.", { energy: FALLING });
  assert.deepEqual(Object.keys(v).sort(), ["reason", "state", "waitMs"], "no score, no confidence, no rating");
});
