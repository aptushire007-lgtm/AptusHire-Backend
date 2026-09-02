// Phase 16 acceptance gates — platform console:
//   - a role:"admin" user gets 403 on the platform gate (requireRole);
//   - every platform mutation demands a typed reason;
//   - suspend writes an audit row carrying the reason, and a suspended
//     tenant's admin is locked out by the existing requireActiveCompany gate;
//   - view-as-tenant is READ-ONLY server-side: a POST carrying the view-as
//     header is rejected inside requireAuth before any route logic runs, while
//     a GET behaves as the tenant's own admin (scoped reads);
//   - the header is inert for non-superadmins.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { requireAuth, requireRole, requireActiveCompany } = require("../../middleware/auth");
const { requireReason } = require("../../routes/platformRoutes");
const { suspendTenant } = require("../../controllers/platformController");
const User = require("../../models/User");
const Company = require("../../models/Company");
const AuditLog = require("../../models/AuditLog");

const originals = {
  userFindById: User.findById,
  companyFindById: Company.findById,
  auditCreate: AuditLog.create,
};
afterEach(() => {
  User.findById = originals.userFindById;
  Company.findById = originals.companyFindById;
  AuditLog.create = originals.auditCreate;
  delete process.env.AUTH_JWT_SECRET;
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

function authedReq({ role, method = "GET", headers = {}, userId }) {
  process.env.AUTH_JWT_SECRET = "test-auth-secret";
  const id = userId || new mongoose.Types.ObjectId();
  User.findById = async () => ({
    _id: id,
    name: "Platform Staff",
    email: "staff@example.com",
    role,
    company: role === "admin" ? new mongoose.Types.ObjectId() : undefined,
  });
  const token = jwt.sign({ userId: String(id), role }, "test-auth-secret", { expiresIn: "1h" });
  return { method, headers: { authorization: `Bearer ${token}`, ...headers } };
}

// ---------------------------------------------------------------------------
// Role gate + mandatory reason
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: role admin gets 403 from the superadmin gate; superadmin passes", async () => {
  const gate = requireRole("superadmin");

  const res1 = mockRes();
  let passed = false;
  gate({ user: { role: "admin" } }, res1, () => {
    passed = true;
  });
  assert.equal(passed, false);
  assert.equal(res1.statusCode, 403);

  const res2 = mockRes();
  gate({ user: { role: "superadmin" } }, res2, () => {
    passed = true;
  });
  assert.equal(passed, true);
});

test("ACCEPTANCE GATE: every platform mutation demands a typed reason", () => {
  for (const body of [undefined, {}, { reason: "" }, { reason: "no" }, { reason: 42 }]) {
    const res = mockRes();
    let passed = false;
    requireReason({ body }, res, () => {
      passed = true;
    });
    assert.equal(passed, false, `${JSON.stringify(body)} must be rejected`);
    assert.equal(res.statusCode, 400);
  }

  const res = mockRes();
  let passed = false;
  const req = { body: { reason: "  non-payment escalation #4821  " } };
  requireReason(req, res, () => {
    passed = true;
  });
  assert.equal(passed, true);
  assert.equal(req.body.reason, "non-payment escalation #4821", "reason is trimmed and kept for the audit row");
});

// ---------------------------------------------------------------------------
// Suspend → audit row + tenant lockout
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: suspend writes an audit row with the reason; requireActiveCompany then locks the tenant out", async () => {
  const companyId = new mongoose.Types.ObjectId();
  const companyDoc = {
    _id: companyId,
    status: "active",
    async save() {
      this.saved = true;
    },
  };
  Company.findById = async () => companyDoc;
  const audits = [];
  AuditLog.create = async (row) => audits.push(row);

  const res = mockRes();
  await suspendTenant(
    {
      params: { id: String(companyId) },
      body: { reason: "abuse report #77" },
      user: { _id: new mongoose.Types.ObjectId(), role: "superadmin", email: "staff@example.com" },
      method: "POST",
      headers: {},
    },
    res
  );

  assert.equal(companyDoc.status, "suspended");
  assert.equal(res.body.status, "suspended");
  // writeAuditLog persists async fire-and-forget — give it a tick.
  await new Promise((r) => setImmediate(r));
  assert.equal(audits.length, 1, "the mutation wrote exactly one audit row");
  assert.equal(audits[0].action, "platform.tenant.suspend");
  assert.equal(audits[0].meta.reason, "abuse report #77");

  // The existing tenant gate now locks the company's admins out.
  Company.findById = () => ({ select: async () => ({ status: "suspended" }) });
  const res2 = mockRes();
  let passed = false;
  await requireActiveCompany({ user: { company: companyId } }, res2, () => {
    passed = true;
  });
  assert.equal(passed, false);
  assert.equal(res2.statusCode, 403);
  assert.equal(res2.body.code, "COMPANY_INACTIVE");

  // Reactivation restores access.
  Company.findById = () => ({ select: async () => ({ status: "active" }) });
  const res3 = mockRes();
  await requireActiveCompany({ user: { company: companyId } }, res3, () => {
    passed = true;
  });
  assert.equal(passed, true);
});

// ---------------------------------------------------------------------------
// View-as-tenant: read-only server-side
// ---------------------------------------------------------------------------

test("ACCEPTANCE GATE: a POST under view-as is rejected server-side before any route logic", async () => {
  const viewedCompany = new mongoose.Types.ObjectId();
  const req = authedReq({
    role: "superadmin",
    method: "POST",
    headers: { "x-view-as-company": String(viewedCompany) },
  });
  const res = mockRes();
  let passed = false;
  await requireAuth(req, res, () => {
    passed = true;
  });
  assert.equal(passed, false, "the mutation never reaches the route");
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "VIEW_AS_READ_ONLY");
});

test("view-as GET behaves as the viewed tenant's admin — scoped, role-mapped, flagged", async () => {
  const viewedCompany = new mongoose.Types.ObjectId();
  const req = authedReq({
    role: "superadmin",
    method: "GET",
    headers: { "x-view-as-company": String(viewedCompany) },
  });
  const res = mockRes();
  let passed = false;
  await requireAuth(req, res, () => {
    passed = true;
  });
  assert.equal(passed, true);
  assert.equal(req.viewAsTenant, true);
  assert.equal(req.user.role, "admin", "reads pass the tenant's own role gates");
  assert.equal(String(req.user.company), String(viewedCompany));
});

test("the view-as header is inert for a normal admin — no privilege sideways-move", async () => {
  const otherCompany = new mongoose.Types.ObjectId();
  const req = authedReq({
    role: "admin",
    method: "GET",
    headers: { "x-view-as-company": String(otherCompany) },
  });
  const res = mockRes();
  let passed = false;
  await requireAuth(req, res, () => {
    passed = true;
  });
  assert.equal(passed, true);
  assert.equal(req.viewAsTenant, undefined);
  assert.notEqual(String(req.user.company), String(otherCompany), "an admin cannot view another tenant");
});
