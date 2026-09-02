// Every portal guard must run the rest of its request inside the tenant it just authenticated.
//
// `models/plugins/tenantScope.js` is the safety net under 26 of the 40 models: it injects
// `{ company: <tenantId> }` into any query that forgot one. The net only exists inside a tenant
// context, and only `requireAuth` and `requireScorecardAuth` were opening one. `requireCandidateAuth`,
// `requirePhoneAuth` and `requireAssessmentAuth` called `next()` bare — so the whole
// /interview-portal and /assessment-portal surface ran with NO context at all: not scoped, and not
// system either. Every query on those paths fell straight through the net, and any handler that
// forgot an explicit company filter was reading across tenants.
//
// scorecardAuth had always done it and said why (its comment: so that path "does not become a
// strict-mode (TENANT_GUARD_STRICT) hole"). By its own standard the other three were holes.
//
// Nothing else in the suite touches tenantScope or tenantContext — `grep -rl tenantScope
// test/unit/` found one file, and only to monkey-patch it. This is the acceptance gate for the
// property itself, written as a FAMILY invariant rather than three one-offs: a fourth portal added
// later fails here until it scopes too.
//
// No DB: each model's findById is monkey-patched, in the style interviewLinkEpoch already uses.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const InterviewSession = require("../../models/InterviewSession");
const AssessmentSession = require("../../models/AssessmentSession");
const RoundScorecard = require("../../models/RoundScorecard");
const tenantContext = require("../../utils/tenantContext");

const { requireCandidateAuth, requirePhoneAuth } = require("../../middleware/candidateAuth");
const { requireAssessmentAuth } = require("../../middleware/assessmentAuth");
const { requireScorecardAuth } = require("../../middleware/scorecardAuth");

process.env.JWT_SECRET = "test-secret";

const originals = {
  interview: InterviewSession.findById,
  assessment: AssessmentSession.findById,
  scorecard: RoundScorecard.findById,
};

test.after(() => {
  InterviewSession.findById = originals.interview;
  AssessmentSession.findById = originals.assessment;
  RoundScorecard.findById = originals.scorecard;
});

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(c) {
      res.statusCode = c;
      return res;
    },
    json(p) {
      res.body = p;
      return res;
    },
  };
  return res;
}

const future = () => new Date(Date.now() + 3_600_000);

// Each portal: how to stand up a live principal, and how to mint a token that opens it.
function portals() {
  const company = new mongoose.Types.ObjectId();
  const candidate = new mongoose.Types.ObjectId();
  const id = new mongoose.Types.ObjectId();

  const interviewSession = { _id: id, company, candidate, status: "in_progress", expiresAt: future(), sessionEpoch: 0 };
  const assessmentSession = { _id: id, company, candidate, status: "in_progress", expiresAt: future() };
  const scorecard = { _id: id, company, status: "pending", expiresAt: future() };

  InterviewSession.findById = async () => interviewSession;
  AssessmentSession.findById = async () => assessmentSession;
  RoundScorecard.findById = async () => scorecard;

  const sign = (payload, opts) => jwt.sign(payload, "test-secret", { expiresIn: "1h", ...opts });

  return {
    company: String(company),
    cases: [
      {
        name: "requireCandidateAuth (interview portal)",
        guard: requireCandidateAuth,
        token: sign({ candidateId: String(candidate), sessionId: String(id), epoch: 0 }),
      },
      {
        name: "requirePhoneAuth (phone companion)",
        guard: requirePhoneAuth,
        token: sign({ candidateId: String(candidate), sessionId: String(id), epoch: 0 }, { audience: "phone-cam" }),
      },
      {
        name: "requireAssessmentAuth (assessment portal)",
        guard: requireAssessmentAuth,
        token: sign({ candidateId: String(candidate), sessionId: String(id) }, { audience: "assessment" }),
      },
      {
        name: "requireScorecardAuth (interviewer scorecard)",
        guard: requireScorecardAuth,
        token: sign({ scorecardId: String(id) }, { audience: "scorecard" }),
      },
    ],
  };
}

test("ACCEPTANCE GATE: every portal guard runs next() inside its principal's tenant", async () => {
  const { company, cases } = portals();

  for (const { name, guard, token } of cases) {
    const res = mockRes();
    let seenTenant = "NEVER CALLED";
    let wasSystem = null;

    await guard({ headers: { authorization: `Bearer ${token}` }, params: {}, body: {}, query: {} }, res, () => {
      seenTenant = tenantContext.getTenantId();
      wasSystem = tenantContext.isSystem();
    });

    assert.equal(res.statusCode, 200, `${name} rejected a valid token (${JSON.stringify(res.body)})`);
    assert.equal(seenTenant, company, `${name} must run next() scoped to the principal's company`);
    // Scoped, NOT trusted-system. runAsSystem would also silence the strict guard, but it would
    // silence the filter too — which is the opposite of what a candidate-facing request wants.
    assert.equal(wasSystem, false, `${name} must scope the request, not run it as system`);
  }
});

test("the tenant context does not leak out past the request", async () => {
  const { cases } = portals();
  const { guard, token } = cases[0];

  await guard({ headers: { authorization: `Bearer ${token}` }, params: {}, body: {}, query: {} }, mockRes(), () => {});

  assert.equal(tenantContext.getTenantId(), undefined, "context must not escape the AsyncLocalStorage run");
  assert.equal(tenantContext.isSystem(), false);
});

test("a rejected token never opens a tenant context", async () => {
  portals();
  const res = mockRes();
  let nextCalled = false;

  await requireCandidateAuth({ headers: { authorization: "Bearer not-a-real-token" }, params: {} }, res, () => {
    nextCalled = true;
  });

  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
  assert.equal(tenantContext.getTenantId(), undefined);
});

// The audience partition, restated here because it is the reason four guards exist rather than one
// — and because scoping them must not have blurred it.
test("scoping did not weaken the audience partition between the portals", async () => {
  const { cases } = portals();
  const [interview, phone, assessment, scorecard] = cases;

  const crossed = [
    ["an assessment token on the interview portal", requireCandidateAuth, assessment.token],
    ["a scorecard token on the interview portal", requireCandidateAuth, scorecard.token],
    ["an interview token on the assessment portal", requireAssessmentAuth, interview.token],
    ["a phone token on the interview portal", requireCandidateAuth, phone.token],
    ["an interview token on the phone endpoint", requirePhoneAuth, interview.token],
    ["an assessment token on the scorecard portal", requireScorecardAuth, assessment.token],
  ];

  for (const [what, guard, token] of crossed) {
    const res = mockRes();
    let nextCalled = false;
    await guard({ headers: { authorization: `Bearer ${token}` }, params: {}, body: {}, query: {} }, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false, `${what} must not be accepted`);
    assert.equal(res.statusCode, 401, `${what} must be rejected with 401`);
  }
});
