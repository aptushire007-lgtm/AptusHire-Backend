// Single source of truth for "everything we hold about a candidate" — used by both the
// nightly retention job (§5.2) and the on-demand DPDP erasure endpoint (data-principal
// right to be forgotten). Deleting a candidate must remove ALL of their PII artifacts,
// so both paths funnel through here to stay in sync as new artifact types are added.
//
// Callers MUST already be in the correct scope: either a system context (retention job)
// or the owning tenant's context (erasure endpoint). Every query below is additionally
// filtered by the candidate's own `company`, so it can never touch another tenant.

const Candidate = require("../models/Candidate");
const InterviewSession = require("../models/InterviewSession");
const InterviewQueue = require("../models/InterviewQueue");
const UsageEvent = require("../models/UsageEvent");
const ReviewItem = require("../models/ReviewItem");
const storageService = require("./storageService");
const evidenceClipService = require("./evidenceClipService");
const interviewRecordingService = require("./interviewRecordingService");

async function deleteObjectSafe(ref, label) {
  if (!ref) return;
  try {
    await storageService.deleteObject(ref);
  } catch (err) {
    console.error(`[candidatePurge] failed to delete ${label} object ${ref}:`, err.message);
  }
}

// Hard-delete a candidate and all associated artifacts (resume file, identity photo,
// interview session/transcript, queue entry, usage events, open review items).
// Best-effort on storage: a
// failed object delete is logged, not fatal, so a stuck file can't strand DB cleanup.
// Returns a small summary of what was removed.
async function purgeCandidateArtifacts(candidate) {
  const companyId = candidate.company;
  const scope = { company: companyId, candidate: candidate._id };

  const sessions = await InterviewSession.find(scope).select(
    "identityVerification aiInterview.turns aiInterview.recordingKey aiInterview.recordingChunks"
  );
  let recordingObjects = 0;
  for (const session of sessions) {
    await deleteObjectSafe(session.identityVerification?.photoPath, "identity-photo");
    // Recorded answer audio (opt-in, voice-consent-gated) dies with the candidate exactly like
    // every other stored artifact here — see models/InterviewSession.js turn.audioKey.
    for (const turn of session.aiInterview?.turns || []) {
      await deleteObjectSafe(turn.audioKey, "answer-audio");
    }
    // THE FULL INTERVIEW RECORDING — and this is a fix, not an addition for the new capture path.
    // The LiveKit Egress path has been writing `recordingKey` since Phase 7 and NOTHING here ever
    // deleted it, so erasing a candidate under their DPDP right to be forgotten left a video of
    // that person's face and voice sitting in the bucket. This service's own header calls itself
    // the single source of truth for "everything we hold about a candidate"; a video of them is
    // the largest thing on that list. Covers both producers: the stitched file and any chunks a
    // partial or interrupted session left behind.
    for (const key of interviewRecordingService.storedKeys(session)) {
      await deleteObjectSafe(key, "interview-recording");
      recordingObjects += 1;
    }
  }
  // Phase 14.4 — evidence clips (rows + stored video objects) die with the
  // candidate, for both DPDP erasure and the nightly retention purge.
  const evidenceClips = await evidenceClipService.purgeForCandidate(companyId, candidate._id);
  const sessionResult = await InterviewSession.deleteMany(scope);
  const queueResult = await InterviewQueue.deleteMany(scope);
  const usageResult = await UsageEvent.deleteMany(scope);
  // The human-review queue holds a pointer to this candidate plus a summary
  // sentence about them, so it is an artifact by this service's own definition
  // and dies with the record. It also has to go for a non-privacy reason: an
  // open item outlives its subject as an unresolvable row that renders a
  // decision about a candidate who no longer exists.
  const reviewResult = await ReviewItem.deleteMany(scope);

  await deleteObjectSafe(candidate.resumePath, "resume");
  await Candidate.deleteOne({ company: companyId, _id: candidate._id });

  return {
    sessions: sessionResult?.deletedCount || 0,
    queueEntries: queueResult?.deletedCount || 0,
    usageEvents: usageResult?.deletedCount || 0,
    reviewItems: reviewResult?.deletedCount || 0,
    evidenceClips,
    recordingObjects,
    resumeDeleted: Boolean(candidate.resumePath),
  };
}

async function removeApplicationFromPipeline({ companyId, candidateId, jobId }) {
  const candidate = await Candidate.findOneAndUpdate(
    { _id: candidateId, company: companyId, job: jobId },
    { $set: { "pipelineExit.at": new Date(), "pipelineExit.reason": "application_removed" } },
    { new: true }
  );
  if (!candidate) return null;

  const scope = { company: companyId, candidate: candidate._id, job: candidate.job };
  const [queueResult, reviewResult] = await Promise.all([
    InterviewQueue.deleteMany(scope),
    ReviewItem.deleteMany(scope),
  ]);

  return {
    candidateId: candidate._id,
    jobId: candidate.job,
    queueEntries: queueResult?.deletedCount || 0,
    reviewItems: reviewResult?.deletedCount || 0,
  };
}

module.exports = { purgeCandidateArtifacts, removeApplicationFromPipeline };
