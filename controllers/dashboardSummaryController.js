const mongoose = require("mongoose");
const Candidate = require("../models/Candidate");
const { pendingReviewLookup } = require("../utils/interviewReview");

const DAY = 86400000;

// Read-only, bounded application summaries. Job lookup is independently tenant scoped.
exports.dashboardSummary = async (req, res) => {
  const company = new mongoose.Types.ObjectId(String(req.user.company));
  const now = new Date();
  const page = Math.max(1, Math.min(1000000, Math.trunc(Number(req.query.page) || 1)));
  const active = { "job._id": { $exists: true }, "pipelineExit.at": null };
  const attention = { ...active, "job.status": { $nin: ["closed", "filled", "archived"] }, $or: [
    { status: "under_review" },
    { "pendingInterviewReviews.0": { $exists: true } },
    { status: "ats_passed", "assessmentDecision.action": { $in: [null, ""] } },
  ] };
  const fields = { _id: 1, basicDetails: { name: "$basicDetails.name" }, job: 1, status: 1, createdAt: 1, updatedAt: 1, assessmentDecision: 1, pendingInterviewReviews: 1 };
  const [result = {}] = await Candidate.aggregate([
    { $match: { company } },
    { $lookup: { from: "jobs", let: { jobId: "$job" }, pipeline: [
      { $match: { company, $expr: { $eq: ["$_id", "$$jobId"] } } },
      { $project: { title: 1, status: 1 } },
    ], as: "job" } },
    { $unwind: { path: "$job", preserveNullAndEmptyArrays: true } },
    pendingReviewLookup(company),
    { $facet: {
      total: [{ $count: "count" }],
      periods: [{ $group: { _id: null,
        last30: { $sum: { $cond: [{ $and: [{ $gt: ["$createdAt", new Date(+now - 30 * DAY)] }, { $lte: ["$createdAt", now] }] }, 1, 0] } },
        prior30: { $sum: { $cond: [{ $and: [{ $gt: ["$createdAt", new Date(+now - 60 * DAY)] }, { $lte: ["$createdAt", new Date(+now - 30 * DAY)] }] }, 1, 0] } },
      } }],
      weeks: [{ $match: { createdAt: { $gt: new Date(+now - 84 * DAY), $lte: now } } },
        { $group: { _id: { $floor: { $divide: [{ $subtract: [now, "$createdAt"] }, 7 * DAY] } }, count: { $sum: 1 } } }],
      stages: [{ $match: active }, { $group: { _id: "$status", count: { $sum: 1 } } }],
      recent: [{ $match: active }, { $sort: { createdAt: -1, _id: -1 } }, { $limit: 5 }, { $project: fields }],
      interviews: [{ $match: { ...active, status: { $in: ["interview_scheduled", "ai_interview_completed"] } } }, { $sort: { updatedAt: -1, _id: -1 } }, { $limit: 4 }, { $project: fields }],
      attentionCount: [{ $match: attention }, { $count: "count" }],
      attention: [{ $match: attention }, { $sort: { createdAt: 1, _id: 1 } }, { $skip: (page - 1) * 20 }, { $limit: 20 }, { $project: fields }],
    } },
  ]);
  const period = result.periods?.[0] || {};
  const stages = (result.stages || []).filter(row => row._id).map(row => [row._id, row.count]).sort((a, b) => b[1] - a[1]);
  res.json({
    total: result.total?.[0]?.count || 0,
    applicantDelta: period.prior30 ? Math.round(((period.last30 - period.prior30) / period.prior30) * 100) : null,
    buckets: Array.from({ length: 12 }, (_, index) => {
      const end = new Date(+now - (11 - index) * 7 * DAY);
      return { label: `${end.getDate()} ${end.toLocaleString("en", { month: "short" })}`, count: result.weeks?.find(row => row._id === 11 - index)?.count || 0 };
    }),
    stages: stages.slice(0, 6), totalWithStage: stages.reduce((sum, row) => sum + row[1], 0) || 1,
    shortlisted: stages.find(row => row[0] === "shortlisted")?.[1] || 0,
    joined: stages.find(row => row[0] === "joined")?.[1] || 0,
    recent: result.recent || [], upcomingInterviews: result.interviews || [],
    attention: result.attention || [], attentionTotal: result.attentionCount?.[0]?.count || 0, page,
  });
};
