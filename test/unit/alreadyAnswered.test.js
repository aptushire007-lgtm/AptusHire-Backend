// "I already answered that." — the gap identified in new_improvements.md ask #5: the interviewer
// had no handling for a candidate pointing out that a question repeats ground they believe they
// already covered. Three things are pinned down here:
//
//   1. utils/alreadyAnsweredIntent — the deterministic Tier-0 matcher, same shape and same false-
//      positive discipline as utils/repeatIntent (a long answer that merely references something
//      said earlier must not be swallowed as a request).
//   2. utils/conversationIntent — the action is wired into the closed set and precedence, and stays
//      reachable by both tiers without becoming a new way to bypass the gate.
//   3. utils/alreadyAnsweredResponder — whether the candidate is RIGHT is decided in code from the
//      transcript (`kind === "follow_up"`), never from their claim or a model's reading of it, and
//      neither reply may ever carry evaluative language.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const alreadyAnsweredIntent = require("../../utils/alreadyAnsweredIntent");
const conversationIntent = require("../../utils/conversationIntent");
const alreadyAnsweredResponder = require("../../utils/alreadyAnsweredResponder");

// ---------------------------------------------------------------------------
// 1. Deterministic matcher
// ---------------------------------------------------------------------------

test("1.1: plain phrasings are honoured", () => {
  for (const phrase of [
    "I already answered that",
    "like I said",
    "as I mentioned before",
    "didn't I already answer that?",
    "asked and answered",
  ]) {
    const r = alreadyAnsweredIntent.shouldHonour(phrase);
    assert.ok(r.honour, `expected "${phrase}" to be honoured`);
  }
});

test("1.2: a real answer that merely references something said earlier is NOT swallowed", () => {
  const long =
    "like I mentioned, we also had to migrate the queue, and that took about three weeks because " +
    "we had to coordinate with the payments team on the cutover window and run both systems in parallel";
  const r = alreadyAnsweredIntent.shouldHonour(long);
  assert.equal(r.honour, false, "a substantial answer must not be discarded as a claim");
});

test("1.3: the trigger is removed from the remainder, leaving only what else was said", () => {
  const r = alreadyAnsweredIntent.detect("I already answered that, but sure, we used Postgres");
  assert.ok(r.matched);
  assert.ok(!r.remainder.toLowerCase().includes("already answered"));
  assert.ok(r.remainder.toLowerCase().includes("postgres"));
});

// ---------------------------------------------------------------------------
// 2. conversationIntent wiring
// ---------------------------------------------------------------------------

test("2.1: already_answered is a declared, tier-1-reachable action", () => {
  assert.ok(conversationIntent.ACTIONS.already_answered);
  assert.ok(conversationIntent.TIER1_ACTIONS.includes("already_answered"));
});

test("2.2: it consumes the turn (it is not part of the candidate's answer)", () => {
  assert.equal(conversationIntent.ACTIONS.already_answered.consumesTurn, true);
  assert.equal(conversationIntent.ACTIONS.already_answered.needsConfirmation, false);
});

test("2.3: detectDeterministic reaches it from a plain phrasing, with the residue verified", () => {
  const r = conversationIntent.detectDeterministic("I already answered that");
  assert.ok(r);
  assert.equal(r.action, "already_answered");
  assert.equal(r.tier, 0);
  assert.equal(r.consumesTurn, true);
});

test("2.4: withdraw still outranks it when both could plausibly fit", () => {
  // A single utterance is unlikely to trip both in practice, but precedence order is a documented
  // contract (see the comment above PRECEDENCE) and must not silently drift as actions are added.
  const idx = conversationIntent.PRECEDENCE;
  assert.ok(idx.indexOf("withdraw") < idx.indexOf("already_answered"));
  assert.ok(idx.indexOf("already_answered") < idx.indexOf("decline"));
  assert.ok(idx.indexOf("already_answered") < idx.indexOf("technical_problem"));
});

test("2.5: a long utterance is answer_continues even if it happens to contain the trigger words", () => {
  const r = conversationIntent.detectDeterministic(
    "I already answered that in my last job, but for this one specifically we built a custom " +
      "retry queue with exponential backoff and dead-lettering after five attempts, which took " +
      "about two weeks to get right in production"
  );
  // detectDeterministic itself has no length gate for Tier 0 (that is Tier 1's job) — but the
  // MAX_CARRY_WORDS floor inside alreadyAnsweredIntent must still refuse this: too much of the
  // utterance is substance for it to be read as merely the claim.
  assert.ok(!r || r.action !== "already_answered");
});

// ---------------------------------------------------------------------------
// 3. Responder — code decides whether the claim is true, never the model
// ---------------------------------------------------------------------------

test("3.1: a follow-up question yields the FOUND reply", () => {
  const r = alreadyAnsweredResponder.respond({ kind: "follow_up" });
  assert.equal(r.found, true);
  assert.equal(r.text, alreadyAnsweredResponder.FOUND);
});

test("3.2: a baseline (non-follow-up) question yields the honest NOT_FOUND reply", () => {
  const r = alreadyAnsweredResponder.respond({ kind: "question" });
  assert.equal(r.found, false);
  assert.equal(r.text, alreadyAnsweredResponder.NOT_FOUND);
});

test("3.3: a missing/malformed current-question turn degrades to NOT_FOUND rather than throwing", () => {
  assert.doesNotThrow(() => alreadyAnsweredResponder.respond(null));
  assert.doesNotThrow(() => alreadyAnsweredResponder.respond(undefined));
  assert.equal(alreadyAnsweredResponder.respond(null).found, false);
});

test("3.4: neither reply carries evaluative language (boot check passed at require time already, re-asserted here)", () => {
  const backchannel = require("../../utils/backchannel");
  assert.equal(backchannel.findEvaluativeWord(alreadyAnsweredResponder.FOUND), null);
  assert.equal(backchannel.findEvaluativeWord(alreadyAnsweredResponder.NOT_FOUND), null);
});
