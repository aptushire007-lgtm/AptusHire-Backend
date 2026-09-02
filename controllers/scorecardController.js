// Admin-side scorecard routes: invite a panelist to a human round, track who has
// filled theirs in, and read the Evidence Ledger.
//
// Note what is NOT here: there is no endpoint that edits a submitted scorecard
// and none that lets a recruiter set a rating on someone else's behalf. The
// artifact's whole value is that it records what a named person observed.

const RoundScorecard = require("../models/RoundScorecard");
const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const scorecardService = require("../services/scorecardService");
const { ROUND_STAGES, STAGE_LABELS } = require("../utils/pipeline");

function adminView(scorecard) {
  return {
    id: String(scorecard._id),
    stage: scorecard.stage,
    stageLabel: STAGE_LABELS[scorecard.stage] || scorecard.stage,
    status: scorecard.status,
    interviewer: scorecard.interviewer,
    invitedBy: scorecard.invitedBy,
    openedAt: scorecard.openedAt,
    submittedAt: scorecard.submittedAt,
    expiresAt: scorecard.expiresAt,
    decision: scorecard.decision,
    decisionReason: scorecard.decisionReason,
    rubricVersion: scorecard.rubricVersion,
    targetClaims: scorecard.targetClaims,
    ratings: scorecard.ratings,
    rollup: scorecard.rollup,
    // Only meaningful once submitted; before that it would show a recruiter the
    // number the interviewer is being kept blind to, which defeats the point.
    engineSnapshot: scorecard.status === "submitted" ? scorecard.engineSnapshot : undefined,
    disagreement: scorecard.status === "submitted" ? scorecard.disagreement : undefined,
  };
}

async function create(req, res) {
  const { candidateId, stage, interviewer } = req.body;
  if (!ROUND_STAGES.includes(stage)) {
    return res.status(400).json({ error: `stage must be one of ${ROUND_STAGES.join(", ")}` });
  }
  const { scorecard, token, candidate, job } = await scorecardService.createScorecard({
    candidateId,
    companyId: req.user.company,
    stage,
    interviewer,
    invitedBy: { user: req.user._id, name: req.user.name },
  });
  await scorecardService.sendInvite({ scorecard, token, candidate, job });
  res.status(201).json({ scorecard: adminView(scorecard) });
}

async function listForCandidate(req, res) {
  const candidate = await Candidate.findOne({ _id: req.params.candidateId, company: req.user.company });
  if (!candidate) return res.status(404).json({ error: "Candidate not found" });
  const scorecards = await RoundScorecard.find({ candidate: candidate._id, company: req.user.company }).sort({ createdAt: -1 });
  res.json({ scorecards: scorecards.map(adminView) });
}

async function getOne(req, res) {
  const scorecard = await RoundScorecard.findOne({ _id: req.params.id, company: req.user.company });
  if (!scorecard) return res.status(404).json({ error: "Scorecard not found" });
  res.json({ scorecard: adminView(scorecard) });
}

async function resend(req, res) {
  const scorecard = await scorecardService.resendInvite({ scorecardId: req.params.id, companyId: req.user.company });
  res.json({ scorecard: adminView(scorecard), message: "A fresh link was sent — the previous one no longer works" });
}

async function cancel(req, res) {
  const scorecard = await scorecardService.cancelScorecard({ scorecardId: req.params.id, companyId: req.user.company });
  res.json({ scorecard: adminView(scorecard) });
}

async function ledger(req, res) {
  const data = await scorecardService.ledgerForCandidate({
    candidateId: req.params.candidateId,
    companyId: req.user.company,
  });
  res.json(data);
}

/** The round stages a scorecard can be raised for, for the admin picker. */
async function options(req, res) {
  res.json({ stages: ROUND_STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] || s })) });
}

module.exports = { create, listForCandidate, getOne, resend, cancel, ledger, options };
