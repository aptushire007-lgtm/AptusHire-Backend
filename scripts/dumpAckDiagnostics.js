// READ-ONLY diagnostic dump for item #6 (ack-quality investigation).
// Run from backend/:  node scripts/dumpAckDiagnostics.js [sessionId]
// With no sessionId, uses the most recently updated session that has backchannels recorded.
//
// Prints, in order:
//   1. Every backchannel/ack decision on the session (shape, source, grounded, rejection, term)
//   2. The keyterm list actually recorded for this session's ASR (voiceAsr.keyterms), and whether
//      "canva" appears in it
//   3. The job's requiredSkills and the candidate's résumé-derived skill/certification claims,
//      and whether "canva" appears in either (i.e. was it ever DECLARED IN WRITING, since keyterms
//      only bias on written vocabulary by design)
//   4. How many agent utterances exactly match one of the three FILLER_LINES strings, out of how
//      many total agent utterances — the empirical filler-firing count for FILLER_AFTER_SECONDS
//
// Read-only: no writes, no $set, no --fix flag. Safe to run against production.

require("dotenv").config();
const mongoose = require("mongoose");
require("../config/dnsOverride").applyDnsOverride();
const InterviewSession = require("../models/InterviewSession");
const Job = require("../models/Job");
const Candidate = require("../models/Candidate");
const ClaimGraph = require("../models/ClaimGraph");

const FILLER_LINES = ["One moment.", "Okay — one second.", "Just a moment."];

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) throw new Error("No MONGODB_URI/MONGO_URI in backend/.env");
  await mongoose.connect(uri);

  const argId = process.argv[2];
  let session = argId ? await InterviewSession.findById(argId).lean() : null;
  if (!session) {
    session = await InterviewSession.findOne({ "aiInterview.backchannels.0": { $exists: true } })
      .sort({ updatedAt: -1 })
      .lean();
    console.log("(using most recent session with backchannels)");
  }
  if (!session) {
    console.log("NO SESSION FOUND");
    return mongoose.disconnect();
  }
  console.log("session:", String(session._id), "| candidate:", String(session.candidate), "| job:", String(session.job));

  console.log("\n--- 1. ack decisions (aiInterview.backchannels) ---");
  const bc = session.aiInterview?.backchannels || [];
  if (!bc.length) console.log("(none recorded)");
  for (const b of bc) {
    console.log(JSON.stringify({
      kind: b.kind, index: b.index, shape: b.shape, source: b.source,
      grounded: b.grounded, rejection: b.rejection, term: b.term,
      text: (b.text || "").slice(0, 90),
    }));
  }

  console.log("\n--- 2. recorded ASR keyterms (voiceAsr.keyterms) ---");
  const keyterms = session.voiceAsr?.keyterms || [];
  console.log(keyterms.length ? keyterms.join(", ") : "(none recorded)");
  console.log("'canva' present in keyterms?", keyterms.some((t) => /canva/i.test(t)));

  console.log("\n--- 3. was Canva ever declared IN WRITING? ---");
  const [job, claimGraph] = await Promise.all([
    Job.findOne({ _id: session.job }).select("requiredSkills title").lean(),
    ClaimGraph.findOne({ candidate: session.candidate, job: session.job }).sort({ createdAt: -1 }).lean(),
  ]);
  console.log("job.requiredSkills:", job?.requiredSkills || []);
  const skillClaims = (claimGraph?.claims || []).filter((c) => c.type === "skill" || c.type === "certification");
  console.log("candidate skill/certification claims:", skillClaims.map((c) => ({
    subject: c.subject, normalized: c.normalized,
  })));
  const canvaInWriting =
    (job?.requiredSkills || []).some((s) => /canva/i.test(s)) ||
    skillClaims.some((c) => /canva/i.test(c.subject || "") || /canva/i.test(c.normalized?.skill || "") || /canva/i.test(c.normalized?.rawSkill || ""));
  console.log("'canva' declared in writing (résumé/rubric)?", canvaInWriting);

  console.log("\n--- 4. filler-gap firing count ---");
  const utterances = (session.aiInterview?.agentUtterances || []).map((u) => (typeof u === "string" ? u : u?.text) || "");
  const fillerCount = utterances.filter((t) => FILLER_LINES.includes(t.trim())).length;
  console.log(`filler lines spoken: ${fillerCount} / ${utterances.length} total agent utterances`);

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
