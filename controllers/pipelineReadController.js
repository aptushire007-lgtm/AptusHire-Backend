const mongoose = require("mongoose");
const Candidate = require("../models/Candidate");
const { pendingReviewLookup } = require("../utils/interviewReview");
const { createPipelineSummary } = require("../utils/pipelineSummary");
const { STAGES } = require("../utils/pipeline");
const phases = {
  screening: ["applied", "ats_passed"], assessment: ["assessment_scheduled", "assessment_completed"],
  interviews: ["interview_scheduled", "ai_interview_completed", "under_review", "shortlisted", "hr_interview", "technical_interview", "manager_interview"],
  offers: ["selected", "offer_sent", "offer_accepted", "joined"], rejected: ["rejected"],
};
const normalize = field => ({ $switch: { branches: [
  { case: { $eq: [field, "next_round"] }, then: "shortlisted" },
  { case: { $eq: [field, "interview_queue"] }, then: "interview_scheduled" },
], default: field } });

exports.pipelineRead = async (req, res) => {
  const company = new mongoose.Types.ObjectId(String(req.user.company));
  const job = req.query.job;
  if (job && job !== "all" && !mongoose.isValidObjectId(job)) return res.status(400).json({ error: "Invalid job filter" });
  const page = Math.max(1, Math.min(1000000, Math.trunc(Number(req.query.page) || 1)));
  const q = String(req.query.q || "").trim().slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const base = [
    { $match: { company } },
    { $lookup: { from: "jobs", let: { id: "$job" }, pipeline: [
      { $match: { company, $expr: { $eq: ["$_id", "$$id"] } } }, { $project: { title: 1, status: 1, department: 1 } },
    ], as: "job" } },
    { $unwind: { path: "$job", preserveNullAndEmptyArrays: true } },
  ];
  const active = { "job._id": { $exists: true }, "pipelineExit.at": null, "job.status": { $nin: ["closed", "filled", "archived"] } };
  const filtered = [...base, { $match: active },
    ...(job && job !== "all" ? [{ $match: { "job._id": new mongoose.Types.ObjectId(job) } }] : []),
    { $set: { status: normalize("$status"), _score: { $cond: [
      { $or: [{ $ifNull: ["$ats.scoredAt", false] }, { $and: [{ $ifNull: ["$ats.decision", false] }, { $ne: ["$ats.decision", "pending"] }] }] },
      { $ifNull: ["$ats.overallScore", -1] }, -1,
    ] } } },
    ...(q ? [{ $match: { $or: [{ "basicDetails.name": { $regex: q, $options: "i" } }, { "job.title": { $regex: q, $options: "i" } }, { skills: { $regex: q, $options: "i" } }, { $expr: { $regexMatch: { input: { $cond: [{ $gte: ["$_score", 0] }, { $toString: "$_score" }, ""] }, regex: q, options: "i" } } }] } }] : []),
  ];
  // Summaries stream a narrow projection in constant memory. No full application array.
  const accumulator = createPipelineSummary();
  const cursor = Candidate.aggregate([...filtered, { $project: { status: 1, createdAt: 1, stageHistory: 1, "ats.overallScore": 1, "ats.decision": 1, "ats.scoredAt": 1, "offer.sentAt": 1 } }]).cursor({ batchSize: 200 });
  try { for await (const candidate of cursor) accumulator.add(candidate); }
  finally { await cursor.close(); }
  const summary = accumulator.result();
  const phaseStages = phases[req.query.phase] || [...STAGES, "rejected"];
  const total = phaseStages.reduce((sum, stage) => sum + (summary.stages[stage] || 0), 0);
  const pages = Math.max(1, Math.ceil(total / 50));
  const effectivePage = Math.min(page, pages);
  const sort = { score_desc: { _score: -1 }, score_asc: { _score: 1 }, newest: { createdAt: -1 }, name: { _name: 1 }, stage_age: { _entered: 1 } }[req.query.sort] || { _score: -1 };
  const [items, totals] = await Promise.all([
    Candidate.aggregate([...filtered, { $match: { status: { $in: phaseStages } } },
      { $set: { _name: { $toLower: { $ifNull: ["$basicDetails.name", ""] } }, _entered: { $reduce: { input: { $ifNull: ["$stageHistory", []] }, initialValue: "$createdAt", in: { $cond: [{ $and: [{ $eq: [normalize("$$this.stage"), "$status"] }, { $ifNull: ["$$this.at", false] }] }, "$$this.at", "$$value"] } } } } },
      { $sort: { ...sort, _id: 1 } }, { $skip: (effectivePage - 1) * 50 }, { $limit: 50 },
      pendingReviewLookup(company),
      { $project: { basicDetails: { name: "$basicDetails.name" }, job: 1, status: 1, skills: 1, stageHistory: 1, ats: 1, hostility: 1, createdAt: 1, offer: 1, pendingInterviewReviews: 1 } },
    ]),
    Candidate.aggregate([...base, { $facet: { total: [{ $count: "count" }], jobs: [{ $match: active }, { $group: { _id: "$job._id", count: { $sum: 1 } } }] } }]),
  ]);
  const countsByJob = Object.fromEntries((totals[0]?.jobs || []).map(row => [String(row._id), row.count]));
  const activeTotal = Object.values(countsByJob).reduce((sum, count) => sum + count, 0);
  res.json({ ...summary, items, total, pages, page: effectivePage, countsByJob, activeTotal, applicationTotal: totals[0]?.total?.[0]?.count || 0, historicalCount: (totals[0]?.total?.[0]?.count || 0) - activeTotal });
};
