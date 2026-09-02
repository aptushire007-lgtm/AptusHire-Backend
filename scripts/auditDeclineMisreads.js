#!/usr/bin/env node
//
// Find — and optionally repair — interviews where a candidate declined a question and the record
// says they answered it badly.
//
// WHAT WENT WRONG. Until 2026-08-25 the realtime path decided whether a turn was a decline by
// trusting a boolean the room model supplied, and the only server-side re-check ran in the
// direction that protects the SCORE (a model over-flagging could not delete an answer). Nothing
// checked the direction that protects the CANDIDATE. A model reporting `declined: false` on a
// genuine skip had that reading accepted, and the turn was stored as an answer and scored.
//
// The cost is not cosmetic. A declined question is meant to be excluded from the answer-score mean
// and reported as a decline; instead these turns entered the mean as zeros. In the session that
// exposed this, seven of thirteen scored answers were declines, every one scored zero, and the
// evaluation reported a decline count of zero — so nothing on the recruiter's screen suggested the
// number was computed over half an interview.
//
// WHAT THIS SCRIPT DOES NOT DO. It never re-reads audio and never asks a model. It replays
// utils/turnComposition — the same deterministic classifier the live path now uses — over stored
// transcripts. A turn is only ever touched when the classifier reads it as an act AND finds no
// answer content in it, which is the same asymmetry the live path enforces: this can decline a
// turn nobody scored well, and it can never delete an answer.
//
// USAGE
//   node scripts/auditDeclineMisreads.js                 # report only, changes nothing
//   node scripts/auditDeclineMisreads.js --fix           # re-flag the turns, drop the false zeros
//   node scripts/auditDeclineMisreads.js --fix --refinalize
//                                                        # ...and recompute the evaluation
//   node scripts/auditDeclineMisreads.js --session <id>  # limit to one session
//
// --fix alone leaves `aiInterview.evaluation` in place but stamps `reviewRequired`, because a
// stored overall score computed over false zeros is wrong and a human should see it before a
// candidate is compared against it. --refinalize clears the evaluation and re-runs the ordinary
// finalization pipeline, which COSTS MODEL CALLS and will produce a different score — that is the
// point, but it is why it is opt-in and separate.

require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const mongoose = require("mongoose");
require("../config/dnsOverride").applyDnsOverride();

const InterviewSession = require("../models/InterviewSession");
const turnComposition = require("../utils/turnComposition");
const aiInterview = require("../services/aiInterviewService");

const args = process.argv.slice(2);
const FIX = args.includes("--fix");
const REFINALIZE = args.includes("--refinalize");
const ONLY = (() => {
  const i = args.indexOf("--session");
  return i >= 0 ? args[i + 1] : null;
})();

const short = (s, n = 120) => String(s || "").replace(/\s+/g, " ").slice(0, n);

// A turn is a misread only if the classifier honours an act on it and finds no answer content.
// `already_answered`, `repeat` and `meta` are reported but never converted to declines here — they
// need a different remedy (the interview should have responded to them, not skipped past them) and
// silently marking them declined would replace one wrong record with another.
function misreadOf(turn) {
  if (turn.role !== "candidate") return null;
  if (turn.kind !== "answer") return null;
  if (turn.declined) return null;
  const r = turnComposition.classify(turn.text);
  if (!r.act || r.isAnswer) return null;
  return r;
}

async function main() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not set. Run this from the backend/ directory so it picks up backend/.env");
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });

  const query = ONLY ? { _id: ONLY } : { "aiInterview.turns.0": { $exists: true } };
  const sessions = await InterviewSession.find(query).select("_id aiInterview candidate job status");

  let scanned = 0;
  let affectedSessions = 0;
  let declineMisreads = 0;
  let otherActs = 0;
  let zerosRemoved = 0;
  const touched = [];

  for (const session of sessions) {
    const ai = session.aiInterview;
    if (!ai || !Array.isArray(ai.turns)) continue;

    const hits = [];
    for (let i = 0; i < ai.turns.length; i++) {
      const turn = ai.turns[i];
      if (turn.role === "candidate" && turn.kind === "answer" && !turn.declined) scanned++;
      const r = misreadOf(turn);
      if (r) hits.push({ index: i, turn, reading: r });
    }
    if (!hits.length) continue;

    const declines = hits.filter((h) => h.reading.act === "decline");
    otherActs += hits.length - declines.length;
    if (!declines.length) continue;

    affectedSessions++;
    declineMisreads += declines.length;

    const scoredAnswers = ai.turns.filter(
      (t) => t.role === "candidate" && t.kind === "answer" && typeof t.answerScore === "number"
    );
    const falseZeros = declines.filter((h) => typeof h.turn.answerScore === "number");
    zerosRemoved += falseZeros.length;

    console.log(`\nsession ${session._id}  status=${session.status || "-"}`);
    console.log(
      `  scored answers: ${scoredAnswers.length}   of which misread declines: ${falseZeros.length}` +
        `   stored overall: ${ai.evaluation?.overallScore ?? "-"}   stored declineCount: ${ai.evaluation?.coverage?.declined ?? "-"}`
    );
    for (const h of declines) {
      console.log(
        `  turn #${h.index}  score=${h.turn.answerScore ?? "-"}  trigger="${h.reading.matchedTrigger || "-"}"`
      );
      console.log(`      "${short(h.turn.text, 150)}"`);
    }
    for (const h of hits.filter((x) => x.reading.act !== "decline")) {
      console.log(`  turn #${h.index}  [${h.reading.act}] not converted — needs a response, not a skip`);
      console.log(`      "${short(h.turn.text, 150)}"`);
    }

    if (!FIX) continue;

    for (const h of declines) {
      const turn = ai.turns[h.index];
      turn.declined = true;
      turn.declineAct = "decline";
      if (h.reading.matchedTrigger) turn.declineTrigger = h.reading.matchedTrigger;
      // The score is removed rather than zeroed. A zero is a finding about the candidate; there is
      // no finding here, and leaving one behind is exactly the defect being repaired.
      turn.answerScore = undefined;
    }

    if (REFINALIZE) {
      ai.evaluation = undefined;
    } else if (ai.evaluation) {
      // The stored number was computed over the false zeros and is now known to be wrong. Say so
      // in the record rather than leaving it to be read as though it still held.
      ai.evaluation.reviewRequired = true;
      ai.evaluation.reviewRequiredReason = [ai.evaluation.reviewRequiredReason, "decline_misread_repaired"]
        .filter(Boolean)
        .join(",");
    }

    await session.save();
    touched.push(String(session._id));

    if (REFINALIZE) {
      try {
        await aiInterview.runFinalization(session._id);
        const after = await InterviewSession.findById(session._id).select("aiInterview.evaluation").lean();
        console.log(`  refinalized → overall ${after?.aiInterview?.evaluation?.overallScore ?? "-"}`);
      } catch (e) {
        console.error(`  refinalize FAILED: ${e.message}`);
      }
    }
  }

  console.log("\n========================================");
  console.log(`sessions examined      : ${sessions.length}`);
  console.log(`unflagged answers seen : ${scanned}`);
  console.log(`sessions affected      : ${affectedSessions}`);
  console.log(`declines misread       : ${declineMisreads}`);
  console.log(`false zeros in a mean  : ${zerosRemoved}`);
  console.log(`other acts (reported)  : ${otherActs}`);
  if (!FIX) {
    console.log("\nreport only — nothing was written. Re-run with --fix to repair.");
  } else {
    console.log(`\nrepaired: ${touched.length} session(s)`);
    if (!REFINALIZE) {
      console.log("evaluations were flagged for review, not recomputed. Add --refinalize to recompute.");
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
