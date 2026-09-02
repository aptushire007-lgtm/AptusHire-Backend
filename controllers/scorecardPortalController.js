// Panelist scorecard portal. Three endpoints, no account, no session state to
// speak of: open the form, read it, submit it once.
//
// `me` returns scorecardService.panelistPayload, which is an allow-list that
// never reads the engine's score — the blind-first guarantee is enforced by what
// this controller CAN return, not by what the client chooses to render.

const Candidate = require("../models/Candidate");
const Job = require("../models/Job");
const RoleRubric = require("../models/RoleRubric");
const scorecardService = require("../services/scorecardService");
const tenantContext = require("../utils/tenantContext");

async function login(req, res) {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: "token is required" });
  // The link itself is the credential, so the lookup cannot be tenant-scoped yet.
  const { token: jwtToken, scorecard } = await tenantContext.runAsSystem(() => scorecardService.loginWithToken(token));
  res.json({ token: jwtToken, stage: scorecard.stage, interviewerName: scorecard.interviewer.name });
}

async function me(req, res) {
  const scorecard = req.scorecard;
  const [candidate, job, rubric] = await Promise.all([
    Candidate.findById(scorecard.candidate),
    Job.findById(scorecard.job),
    RoleRubric.findById(scorecard.rubric),
  ]);
  if (!rubric) {
    return res.status(409).json({ error: "The rubric this scorecard was built from is no longer available — please tell the recruiting team" });
  }
  res.json(scorecardService.panelistPayload({ scorecard, candidate, job, rubric }));
}

async function submit(req, res) {
  const { ratings, decision, decisionReason } = req.body;
  const scorecard = await scorecardService.submitScorecard(
    req.scorecard,
    { ratings, decision, decisionReason },
    req
  );
  // The reveal: the interviewer rated blind, so now they get to see how their
  // read compared with the engine's. Nothing about it is editable at this point.
  res.json({
    submitted: true,
    score: scorecard.rollup?.score ?? null,
    withheldReason: scorecard.rollup?.withheldReason || "",
    coverage: scorecard.rollup?.coverage ?? 0,
    reproducibilityHash: scorecard.rollup?.reproducibilityHash || "",
    engineSnapshot: scorecard.engineSnapshot,
    disagreement: scorecard.disagreement,
    message: "Thanks — your scorecard is recorded and can no longer be edited.",
  });
}

module.exports = { login, me, submit };
