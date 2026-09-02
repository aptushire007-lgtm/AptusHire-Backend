// Scorecard-portal auth (RoundScorecard). Same magic-link → JWT pattern as the
// assessment portal, with a distinct `aud: "scorecard"` claim, so the three
// portal audiences are mutually exclusive: candidateAuth rejects any
// audience-bearing token, assessmentAuth demands "assessment", and this demands
// "scorecard". A panelist link can never open a candidate's interview or test,
// and vice versa.
//
// The panelist is deliberately NOT a User. A hiring manager who logs in twice a
// year and an external panelist who never will are the two people most likely to
// leave a round unrecorded; requiring an account is how the scorecard ends up
// empty. The token is the authorization, and the scorecard document names the
// person it was issued to.
//
// Tenant context: the lookup runs as system (the bearer is authenticated by the
// token itself, before any company is known), then the REST of the request runs
// scoped to the scorecard's own company — so every downstream query is tenant-
// filtered exactly as an authenticated admin request would be, and this path
// does not become a strict-mode (TENANT_GUARD_STRICT) hole.

const jwt = require("jsonwebtoken");
const RoundScorecard = require("../models/RoundScorecard");
const tenantContext = require("../utils/tenantContext");

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

async function requireScorecardAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { audience: "scorecard" });
  } catch (err) {
    return res.status(401).json({ error: "Your scorecard session expired — please open your interview link again" });
  }

  const scorecard = await tenantContext.runAsSystem(() => RoundScorecard.findById(payload.scorecardId));
  if (!scorecard) {
    return res.status(401).json({ error: "Scorecard not found" });
  }
  if (scorecard.status === "cancelled") {
    return res.status(410).json({ error: "This scorecard was withdrawn by the recruiting team" });
  }
  // Submitted is terminal and immutable — re-opening would invite an edit the
  // model would refuse anyway; say so plainly instead of failing at save time.
  if (scorecard.status === "submitted") {
    return res.status(409).json({ error: "You have already submitted this scorecard — submit a correcting one if something needs changing" });
  }
  if (new Date() > scorecard.expiresAt) {
    return res.status(410).json({ error: "This scorecard link has expired — ask the recruiting team to re-send it" });
  }

  req.scorecard = scorecard;
  // Run the remainder of the request inside the scorecard's tenant.
  tenantContext.run({ companyId: String(scorecard.company) }, () => next());
}

module.exports = { requireScorecardAuth };
