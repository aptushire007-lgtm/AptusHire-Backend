// Assembles the speech-to-text keyterm vocabulary for a live interview session and records
// what was actually used.
//
// Two responsibilities, both deliberate:
//   1. Gather — read the role's requiredSkills and the candidate's span-verified skill claims,
//      and hand them to utils/keyterms (pure, deterministic, no LLM).
//   2. Record — persist the exact list on the session. Recorded, NEVER scored. It exists so a
//      candidate who disputes a transcript can have it reconstructed, and so a bias audit can
//      confirm every candidate for a role was given the same role vocabulary.
//
// Failure policy: vocabulary biasing is an accuracy improvement, never a precondition. Every
// path here degrades to "no keyterms" — an unbiased but fully working transcript — rather than
// blocking the microphone. A candidate must never lose their interview slot because a lookup
// for hint words failed.

const Job = require("../models/Job");
const ClaimGraph = require("../models/ClaimGraph");
const Candidate = require("../models/Candidate");
const InterviewSession = require("../models/InterviewSession");
const { buildKeyterms } = require("../utils/keyterms");

async function keytermsForSession(session) {
  if (!session?.job) return [];
  try {
    // Explicit `company` filters throughout: models/plugins/tenantScope respects a caller's
    // own tenant constraint, and the interview portal runs without a tenant context (the
    // candidate is not a tenant user), so scoping here is the real isolation, not a backstop.
    const [job, claimGraph, candidate] = await Promise.all([
      Job.findOne({ _id: session.job, company: session.company }).select("requiredSkills").lean(),
      ClaimGraph.findOne({ candidate: session.candidate, job: session.job, company: session.company })
        .sort({ createdAt: -1 })
        .select("claims.type claims.subject claims.normalized")
        .lean(),
      // The candidate's own name — the proper noun the interview speaks most, and the one an
      // unbiased transcript most visibly mangles (see utils/keyterms for the fairness note).
      Candidate.findOne({ _id: session.candidate, company: session.company })
        .select("basicDetails.name")
        .lean(),
    ]);
    return buildKeyterms({ job, claimGraph, candidateName: candidate?.basicDetails?.name });
  } catch (err) {
    console.error("[asrVocabulary] keyterm lookup failed, continuing unbiased:", err.message);
    return [];
  }
}

// Best-effort audit row. `updateOne` with an explicit filter rather than `session.save()`:
// the streaming token is minted once per answer, concurrently with proctoring event flushes
// that save the same document, and a targeted $set cannot clobber their writes.
async function recordKeyterms(session, keyterms, sttModel) {
  const terms = Array.isArray(keyterms) ? keyterms : [];
  try {
    const existing = session?.voiceAsr?.keyterms || [];
    const unchanged =
      existing.length === terms.length &&
      session?.voiceAsr?.model === sttModel &&
      existing.every((t, i) => t === terms[i]);
    if (unchanged) return; // one row per session, not one per answer

    await InterviewSession.updateOne(
      { _id: session._id, company: session.company },
      { $set: { voiceAsr: { keyterms: terms, model: sttModel || "", at: new Date() } } }
    );
    // Keep the in-memory doc consistent so the next call in this process also short-circuits.
    if (session.voiceAsr) {
      session.voiceAsr.keyterms = terms;
      session.voiceAsr.model = sttModel || "";
    }
  } catch (err) {
    console.error("[asrVocabulary] could not record keyterms:", err.message);
  }
}

module.exports = { keytermsForSession, recordKeyterms };
