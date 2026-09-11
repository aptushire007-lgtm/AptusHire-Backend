const FINISHED = ["completed", "ended_early", "abandoned", "halted", "integrity_terminated"];

function reviewState(session) {
  const eligible = FINISHED.includes(session?.aiInterview?.status);
  const version = session?.updatedAt ? new Date(session.updatedAt).toISOString() : null;
  const record = session?.recruiterReview;
  const reviewed = !!(eligible && version && record?.at && record.evidenceUpdatedAt && new Date(record.evidenceUpdatedAt).toISOString() === version);
  return { required: eligible && !reviewed, eligible, version, attempt: session?.attempt || 1,
    history: (session?.recruiterReviewHistory || []).map(entry => ({ at: entry.at, byName: entry.byName, note: entry.note })),
    recorded: record?.at ? { at: record.at, byName: record.byName, note: record.note, current: reviewed } : null };
}

// Includes unresolved older attempts: a new invitation does not erase a review task.
function pendingReviewLookup(company) {
  return { $lookup: { from: "interviewsessions", let: { candidateId: "$_id" }, pipeline: [
    { $match: { company, "aiInterview.status": { $in: FINISHED }, $expr: { $and: [
      { $eq: ["$candidate", "$$candidateId"] },
      { $or: [{ $eq: [{ $ifNull: ["$recruiterReview.at", null] }, null] }, { $ne: [{ $ifNull: ["$recruiterReview.evidenceUpdatedAt", null] }, "$updatedAt"] }] },
    ] } } },
    { $sort: { attempt: 1 } },
    { $project: { _id: 0, attempt: 1, status: "$aiInterview.status" } },
  ], as: "pendingInterviewReviews" } };
}
module.exports = { FINISHED, reviewState, pendingReviewLookup };
