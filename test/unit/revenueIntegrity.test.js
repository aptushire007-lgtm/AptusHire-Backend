// Phase 11 acceptance gates — revenue integrity:
//   - each plan limit provably blocks AT its boundary (used+incoming > limit)
//     with a machine-readable 429 + an AuditLog row, and passes under it;
//   - a tenant with no subscription is never quota-blocked (company-status
//     gates own that case);
//   - subscription lifecycle: active → grace → expired transitions are pure
//     and read the configured grace window;
//   - requireActiveSubscription gates MUTATIONS only, passes reads, and
//     surfaces SUBSCRIPTION_EXPIRED as a machine-readable 403;
//   - GUARDRAIL: the aiInterviews quota is enforced only at interview START —
//     an in-flight interview can never be killed by a limit.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const mongoose = require("mongoose");

const quotaService = require("../../services/quotaService");
const { assess, graceDays } = require("../../services/subscriptionLifecycleService");
const { requireActiveSubscription } = require("../../middleware/auth");
const Subscription = require("../../models/Subscription");
const Job = require("../../models/Job");
const AuditLog = require("../../models/AuditLog");

const COMPANY = new mongoose.Types.ObjectId();

const originals = {
  subFindOne: Subscription.findOne,
  jobCount: Job.countDocuments,
  auditCreate: AuditLog.create,
};
afterEach(() => {
  Subscription.findOne = originals.subFindOne;
  Job.countDocuments = originals.jobCount;
  AuditLog.create = originals.auditCreate;
  delete process.env.SUBSCRIPTION_GRACE_DAYS;
});

function stubPlan({ maxJobs = 2, status = "active" } = {}) {
  Subscription.findOne = () => ({
    populate: async () => ({
      status,
      currentPeriodStart: new Date(Date.now() - 5 * 86400000),
      currentPeriodEnd: new Date(Date.now() + 25 * 86400000),
      plan: { key: "free_trial", name: "Free Trial", limits: { maxJobs } },
    }),
    select: async () => ({ status, currentPeriodEnd: new Date(Date.now() + 25 * 86400000) }),
  });
}

// ---------------------------------------------------------------------------
// Quota boundaries
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: a limit blocks exactly at its boundary and passes under it", async () => {
  stubPlan({ maxJobs: 2 });
  const audits = [];
  AuditLog.create = async (row) => audits.push(row);

  Job.countDocuments = async () => 1; // 1 used of 2 → creating one more is fine
  const under = await quotaService.check(COMPANY, "jobs");
  assert.equal(under.allowed, true);
  assert.equal(under.remaining, 1);

  Job.countDocuments = async () => 2; // at the cap → the next one must block
  await assert.rejects(
    () => quotaService.enforce(COMPANY, "jobs", { actor: { email: "a@example.com" } }),
    (err) => {
      assert.equal(err.status, 429);
      assert.equal(err.code, "QUOTA_EXCEEDED");
      assert.deepEqual(err.quota, { dimension: "jobs", limit: 2, used: 2, planKey: "free_trial" });
      assert.ok(/Upgrade/.test(err.message), "the block explains the way forward");
      return true;
    }
  );
  assert.equal(audits.length, 1, "every block writes an AuditLog row");
  assert.equal(audits[0].action, "quota.blocked");
});

test("no subscription ⇒ quotas never block (company-status gates own that case)", async () => {
  Subscription.findOne = () => ({ populate: async () => null, select: async () => null });
  const r = await quotaService.check(COMPANY, "jobs");
  assert.equal(r.allowed, true);
  assert.equal(r.limit, null);
  await quotaService.enforce(COMPANY, "jobs"); // must not throw
});

test("unknown dimensions fail loudly", async () => {
  await assert.rejects(() => quotaService.check(COMPANY, "nonsense"), /Unknown quota dimension/);
});

// ---------------------------------------------------------------------------
// Subscription lifecycle
// ---------------------------------------------------------------------------

test("assess: active inside the period, grace inside the window, expired past it, none without a sub", () => {
  process.env.SUBSCRIPTION_GRACE_DAYS = "7";
  const now = new Date("2026-07-25T00:00:00Z");
  const sub = (end) => ({ currentPeriodEnd: new Date(end) });
  assert.equal(assess(null, now), "none");
  assert.equal(assess(sub("2026-08-01"), now), "active");
  assert.equal(assess(sub("2026-07-20"), now), "grace"); // 5 days past, 7-day grace
  assert.equal(assess(sub("2026-07-10"), now), "expired"); // 15 days past
  assert.equal(graceDays(), 7);
});

test("grace window is configurable and 0-grace expires immediately after the period", () => {
  process.env.SUBSCRIPTION_GRACE_DAYS = "0";
  const now = new Date("2026-07-25T00:00:00Z");
  assert.equal(assess({ currentPeriodEnd: new Date("2026-07-24") }, now), "expired");
});

// ---------------------------------------------------------------------------
// requireActiveSubscription middleware
// ---------------------------------------------------------------------------

function run(mw, req) {
  return new Promise((resolve) => {
    mw(req, { setHeader: (k, v) => (req._headers = { ...(req._headers || {}), [k]: v }) }, (err) => resolve(err));
  });
}

test("ACCEPTANCE GATE: an expired subscription blocks mutations with a machine-readable 403", async () => {
  process.env.SUBSCRIPTION_GRACE_DAYS = "7";
  Subscription.findOne = () => ({ select: async () => ({ status: "past_due", currentPeriodEnd: new Date(Date.now() - 30 * 86400000) }) });
  const err = await run(requireActiveSubscription, { method: "POST", user: { company: COMPANY } });
  assert.ok(err, "mutation must be rejected");
  assert.equal(err.status, 403);
  assert.equal(err.code, "SUBSCRIPTION_EXPIRED");
  assert.equal(err.subscription.graceDays, 7);
});

test("reads always pass — expiry is read-only mode, never data lockout", async () => {
  Subscription.findOne = () => {
    throw new Error("reads must not even query the subscription");
  };
  const err = await run(requireActiveSubscription, { method: "GET", user: { company: COMPANY } });
  assert.equal(err, undefined);
});

test("grace passes mutations and flags the state via header", async () => {
  process.env.SUBSCRIPTION_GRACE_DAYS = "7";
  Subscription.findOne = () => ({ select: async () => ({ status: "past_due", currentPeriodEnd: new Date(Date.now() - 2 * 86400000) }) });
  const req = { method: "POST", user: { company: COMPANY } };
  const err = await run(requireActiveSubscription, req);
  assert.equal(err, undefined);
  assert.equal(req._headers["X-Subscription-State"], "grace");
});

test("no subscription row passes (pre-payment states belong to requireActiveCompany)", async () => {
  Subscription.findOne = () => ({ select: async () => null });
  const err = await run(requireActiveSubscription, { method: "DELETE", user: { company: COMPANY } });
  assert.equal(err, undefined);
});

// ---------------------------------------------------------------------------
// GUARDRAIL: never kill an in-flight interview
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: the aiInterviews quota is enforced ONLY when the interview has not started", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../controllers/interviewPortalController.js"), "utf8");
  const guard = src.match(/if \(session\.aiInterview\?\.status === "not_started"\) \{[^}]*enforce\(session\.company, "aiInterviews"\)/s);
  assert.ok(guard, "the quota call must sit inside the not_started guard");
  const enforceCount = (src.match(/enforce\(session\.company, "aiInterviews"/g) || []).length;
  assert.equal(enforceCount, 1, "no other aiInterviews enforcement path exists in the portal");
});
