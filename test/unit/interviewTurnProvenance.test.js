// Per-turn provenance guards (aiInterview.turns[].engine).
//
// Regression: advance() delivers a recruiter-approved must-ask verbatim and stamped the turn
// engine:"approved_set", but the schema enum only listed ai|fallback. The push therefore threw
// on save, and because Mongoose validates paths loaded from the DB as well as modified ones,
// the bad value poisons EVERY later save on that session — the interview stops being able to
// record anything at all, not just that one turn.
//
// These run offline via validateSync; no DB and no network.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");

const InterviewSession = require("../../models/InterviewSession");

const TURN_ENGINE = InterviewSession.schema.path("aiInterview.turns").schema.path("engine");
const SESSION_ENGINE = InterviewSession.schema.path("aiInterview.engine");

function turnError(turn) {
  const doc = new InterviewSession({});
  doc.aiInterview = { turns: [turn] };
  const err = doc.validateSync();
  // The bare doc is missing its required refs; only the turn's own errors matter here.
  return err?.errors?.["aiInterview.turns.0.engine"];
}

test("a must-ask turn records that no model touched it", () => {
  assert.equal(
    turnError({ role: "ai", kind: "question", text: "Describe a system you designed.", engine: "approved_set" }),
    undefined
  );
});

test("the other two provenances still validate", () => {
  for (const engine of ["ai", "fallback"]) {
    assert.equal(turnError({ role: "ai", kind: "question", text: "q", engine }), undefined, engine);
  }
});

test("the enum is still a closed set — an unknown provenance is refused", () => {
  assert.ok(turnError({ role: "ai", kind: "question", text: "q", engine: "gpt_vibes" }));
});

// A session as a WHOLE is only ever ai or fallback: "approved_set" describes one turn's delivery,
// never the interview. Widening the turn enum must not quietly widen this one.
test("the session-level engine stays ai|fallback", () => {
  assert.deepEqual(SESSION_ENGINE.enumValues, ["ai", "fallback"]);
});

// The bug class, not just the one instance: any literal provenance a writer stamps onto a turn
// must be a value the schema accepts. Catches the next `engine: "something_new"` at test time
// instead of mid-interview.
test("every literal engine written onto a turn is in the schema enum", () => {
  const sources = ["services/aiInterviewService.js", "controllers/interviewPortalController.js"];
  const pushes = [];

  for (const rel of sources) {
    const src = fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");
    for (const block of src.matchAll(/turns\.push\(\{[\s\S]*?\}\);/g)) {
      for (const found of block[0].matchAll(/\bengine:\s*"([^"]+)"/g)) {
        pushes.push({ rel, engine: found[1] });
      }
    }
  }

  assert.ok(pushes.length, "found no turn pushes to check — did the regex or the call site move?");
  for (const { rel, engine } of pushes) {
    assert.ok(
      TURN_ENGINE.enumValues.includes(engine),
      `${rel} stamps engine "${engine}" onto a turn, which the schema rejects (allowed: ${TURN_ENGINE.enumValues.join(", ")})`
    );
  }
});

// Guards the amplification, which is what turned a one-turn defect into a dead interview.
test("a pre-existing bad engine value fails an otherwise unrelated save", () => {
  const doc = InterviewSession.hydrate({
    _id: new mongoose.Types.ObjectId(),
    aiInterview: { turns: [{ role: "ai", kind: "question", text: "q", engine: "gpt_vibes" }], intents: [] },
  });
  doc.aiInterview.intents.push({ utterance: "could you repeat that?", action: "repeat", tier: 0 });
  doc.markModified("aiInterview");
  assert.ok(doc.validateSync()?.errors?.["aiInterview.turns.0.engine"]);
});
