const jwt = require("jsonwebtoken");
const InterviewSession = require("../models/InterviewSession");
const tenantContext = require("../utils/tenantContext");

// Shared session-state checks for both the laptop portal token and the phone
// companion token: the session must exist, belong to the token's candidate,
// and still be live.
//
// The lookup itself runs as system because there is no tenant to scope to yet — the token names a
// session, and the session is what names the company. Same shape as scorecardAuth: a deliberate,
// one-query bypass, immediately narrowed by the `tenantContext.run` each caller wraps `next()` in.
async function loadSession(payload, res) {
  const session = await tenantContext.runAsSystem(() => InterviewSession.findById(payload.sessionId));
  if (!session || String(session.candidate) !== payload.candidateId) {
    res.status(401).json({ error: "Interview session not found" });
    return null;
  }
  // A resend/reschedule bumps sessionEpoch and mints a token carrying the new value —
  // any token signed before that (this one included, if the candidate never refreshed)
  // is from a link the recruiter has since replaced. Checked ahead of cancelled/expired
  // so a forced resend during a live interview reports the accurate reason, not "expired".
  if ((payload.epoch || 0) !== (session.sessionEpoch || 0)) {
    res.status(401).json({ error: "This interview link has been replaced with a new one — check your email for the latest link" });
    return null;
  }
  if (session.status === "cancelled") {
    res.status(410).json({ error: "This interview has been cancelled" });
    return null;
  }
  if (new Date() > session.expiresAt) {
    if (session.status !== "expired") {
      session.status = "expired";
      await session.save();
    }
    res.status(410).json({ error: "This interview link has expired" });
    return null;
  }
  return session;
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  return scheme === "Bearer" && token ? token : null;
}

async function requireCandidateAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: "Session expired or invalid, please use your interview link again" });
  }

  // Phase 14.6: phone-companion tokens carry an `aud` claim; the laptop portal
  // token never does. Rejecting any audience-bearing token here keeps the phone
  // token single-purpose — it can heartbeat and upload clips, never start the
  // interview or submit answers.
  if (payload.aud) {
    return res.status(401).json({ error: "This token is not valid for the interview portal" });
  }

  const session = await loadSession(payload, res);
  if (!session) return;

  req.interviewSession = session;
  // The rest of the request runs inside the session's own tenant. Without this the whole
  // /interview-portal surface ran with NO tenant context at all — not scoped, not system — so
  // tenantScope's net (models/plugins/tenantScope.js) silently passed every query straight through
  // and any handler that forgot an explicit `company` filter was querying across all tenants.
  // scorecardAuth has always done this; these two portals were the gap.
  tenantContext.run({ companyId: String(session.company) }, () => next());
}

// Phone-companion auth (Phase 14.6). Accepts ONLY tokens minted for the
// "phone-cam" audience — the session token obtained by exchanging the short-TTL
// QR pairing token. Never accepted by requireCandidateAuth and vice versa.
async function requirePhoneAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET, { audience: "phone-cam" });
  } catch (err) {
    return res.status(401).json({ error: "Phone pairing expired or invalid — rescan the QR code" });
  }

  const session = await loadSession(payload, res);
  if (!session) return;

  req.interviewSession = session;
  // Same tenant scoping as the laptop token above — the phone companion uploads evidence clips
  // against tenant-scoped models too.
  tenantContext.run({ companyId: String(session.company) }, () => next());
}

module.exports = { requireCandidateAuth, requirePhoneAuth };
