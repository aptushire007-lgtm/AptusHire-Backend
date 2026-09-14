const mongoose = require("mongoose");
const Candidate = require("../models/Candidate");
const InterviewSession = require("../models/InterviewSession");
const { reviewState } = require("../utils/interviewReview");

exports.recordInterviewReview = async (req, res) => {
  const { id } = req.params;
  const { attempt, version, note } = req.body || {};
  if (!mongoose.isValidObjectId(id) || !Number.isInteger(attempt) || attempt < 1 || typeof version !== "string" || !Number.isFinite(Date.parse(version)) || typeof note !== "string" || !note.trim() || note.trim().length > 2000) {
    return res.status(400).json({ error: "Choose an interview attempt and enter a review note (1–2000 characters)." });
  }
  const company = req.user.company;
  if (!await Candidate.exists({ _id: id, company })) return res.status(404).json({ error: "Candidate not found." });
  const session = await InterviewSession.findOne({ candidate: id, company, attempt }).lean();
  if (!session) return res.status(404).json({ error: "Interview attempt not found." });
  const state = reviewState(session);
  if (!state.eligible || state.version !== version) return res.status(409).json({ error: "The interview has changed. Reload the evidence before recording your review." });
  if (!state.required) {
    if (String(session.recruiterReview.by) === String(req.user._id) && session.recruiterReview.note === note.trim()) return res.json({ review: state });
    return res.status(409).json({ error: "A review has already been recorded for this evidence. Reload to read it; your note has not replaced it." });
  }
  const record = { at: new Date(), by: req.user._id, byName: req.user.name || req.user.email, note: note.trim(), evidenceUpdatedAt: session.updatedAt };
  const updated = await InterviewSession.findOneAndUpdate({ _id: session._id, company, updatedAt: session.updatedAt,
    "recruiterReview.at": session.recruiterReview?.at || null }, {
      $set: { recruiterReview: record },
      ...(session.recruiterReview?.at ? { $push: { recruiterReviewHistory: session.recruiterReview } } : {}),
    }, { new: true, runValidators: true, timestamps: false }).lean();
  if (!updated) return res.status(409).json({ error: "The interview or its review changed. Reload before trying again." });
  req.audit = { action: "interview.review.record", resourceType: "InterviewSession", resourceId: String(session._id), meta: { candidateId: id, attempt } };
  require("../config/socket").emitToCompany(company, "candidate:review", { candidateId: id, attempt });
  return res.json({ review: reviewState(updated) });
};
