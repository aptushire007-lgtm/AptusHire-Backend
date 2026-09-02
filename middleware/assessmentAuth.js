// Assessment-portal auth (ASSESSMENT-ENGINE-PLAN A2.1). Same magic-link → JWT
// pattern as the interview portal, with a distinct `aud: "assessment"` claim —
// an assessment token can never open the interview portal (candidateAuth rejects
// any audience-bearing token) and vice versa (this verifies the audience).

const jwt = require("jsonwebtoken");
const AssessmentSession = require("../models/AssessmentSession");
const tenantContext = require("../utils/tenantContext");

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

async function requireAssessmentAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { audience: "assessment" });
  } catch (err) {
    return res.status(401).json({ error: "Session expired or invalid, please use your assessment link again" });
  }

  // As system, because the token names a session and the session is what names the company —
  // there is no tenant to scope to until this returns. Narrowed immediately below.
  const session = await tenantContext.runAsSystem(() => AssessmentSession.findById(payload.sessionId));
  if (!session || String(session.candidate) !== payload.candidateId) {
    return res.status(401).json({ error: "Assessment session not found" });
  }
  if (session.status === "cancelled") {
    return res.status(410).json({ error: "This assessment has been cancelled" });
  }
  if (new Date() > session.expiresAt && session.status !== "completed") {
    // Let the service finalize partial work (score-what-exists) before rejecting. Scored inside
    // the session's tenant like any other write — it reads items and writes a result.
    const assessmentService = require("../services/assessmentService");
    await tenantContext.run({ companyId: String(session.company) }, () => assessmentService.expireSession(session));
    return res.status(410).json({ error: "This assessment link has expired" });
  }

  req.assessmentSession = session;
  // The rest of the request runs inside the session's own tenant — see the note in
  // candidateAuth.requireCandidateAuth for what its absence was costing.
  tenantContext.run({ companyId: String(session.company) }, () => next());
}

module.exports = { requireAssessmentAuth };
