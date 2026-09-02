// Phase 13 acceptance — admin-experience backend fixes:
//   - demo requests are PERSISTED first and the sales email is best-effort
//     (the old mailto: flow lost the lead whenever no mail client existed);
//   - demo request input is validated (name + plausible email);
//   - the AuditLog read path is company-scoped, filterable, and paginated —
//     an admin can only ever see their own tenant's trail.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const DemoRequest = require("../../models/DemoRequest");
const AuditLog = require("../../models/AuditLog");
const { createDemoRequest } = require("../../controllers/demoRequestController");
const { listCompanyAuditLogs } = require("../../controllers/auditLogController");

const originals = {
  demoCreate: DemoRequest.create,
  auditFind: AuditLog.find,
  auditCount: AuditLog.countDocuments,
};
afterEach(() => {
  DemoRequest.create = originals.demoCreate;
  AuditLog.find = originals.auditFind;
  AuditLog.countDocuments = originals.auditCount;
  delete process.env.SALES_NOTIFY_EMAIL;
});

function mockRes() {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Demo requests
// ---------------------------------------------------------------------------

test("demo request: persisted with a 201 even when no sales email is configured", async () => {
  let created = null;
  DemoRequest.create = async (doc) => {
    created = doc;
    return { ...doc, _id: new mongoose.Types.ObjectId() };
  };

  const res = mockRes();
  await createDemoRequest(
    {
      body: { companyName: "Acme", email: "lead@example.com", phone: "+91-00000-00001", companySize: "11-50" },
      ip: "127.0.0.1",
      get: () => "test-agent",
    },
    res
  );

  assert.equal(res.statusCode, 201);
  assert.ok(created, "the lead was written to the collection");
  assert.equal(created.email, "lead@example.com");
});

test("demo request: rejects a missing company name and a junk email", async () => {
  let created = false;
  DemoRequest.create = async () => {
    created = true;
    return {};
  };

  for (const body of [
    { email: "lead@example.com" },
    { companyName: "Acme", email: "not-an-email" },
    { companyName: "A", email: "lead@example.com" },
  ]) {
    const res = mockRes();
    await createDemoRequest({ body, ip: "127.0.0.1", get: () => "" }, res);
    assert.equal(res.statusCode, 400, `${JSON.stringify(body)} must 400`);
  }
  assert.equal(created, false, "nothing was persisted for invalid input");
});

// ---------------------------------------------------------------------------
// AuditLog read path
// ---------------------------------------------------------------------------

function stubAuditFind(capture) {
  AuditLog.find = (filter) => {
    capture.filter = filter;
    const chain = {
      sort: () => chain,
      skip: (n) => {
        capture.skip = n;
        return chain;
      },
      limit: (n) => {
        capture.limit = n;
        return chain;
      },
      select: () => chain,
      lean: async () => [{ _id: "row1", action: "POST /api/jobs" }],
    };
    return chain;
  };
  AuditLog.countDocuments = async (filter) => {
    capture.countFilter = filter;
    return 1;
  };
}

test("ACCEPTANCE GATE: audit listing is company-scoped — the tenant filter is always present", async () => {
  const company = new mongoose.Types.ObjectId();
  const capture = {};
  stubAuditFind(capture);

  const res = mockRes();
  await listCompanyAuditLogs({ user: { company }, query: {} }, res);

  assert.equal(String(capture.filter.company), String(company));
  assert.equal(String(capture.countFilter.company), String(company));
  assert.deepEqual(res.body.items.length, 1);
  assert.equal(res.body.total, 1);
});

test("audit listing: an account with no company is rejected, never given a global view", async () => {
  const res = mockRes();
  await listCompanyAuditLogs({ user: {}, query: {} }, res);
  assert.equal(res.statusCode, 400);
});

test("audit listing: action filter is regex-escaped so user input can't widen the query", async () => {
  const capture = {};
  stubAuditFind(capture);

  const res = mockRes();
  await listCompanyAuditLogs(
    { user: { company: new mongoose.Types.ObjectId() }, query: { action: "job.*" } },
    res
  );

  assert.ok(capture.filter.action.$regex.includes("\\.\\*"), "regex metacharacters neutralised");
});

test("audit listing: pagination clamps limit to 100 and computes skip from page", async () => {
  const capture = {};
  stubAuditFind(capture);

  const res = mockRes();
  await listCompanyAuditLogs(
    { user: { company: new mongoose.Types.ObjectId() }, query: { page: "3", limit: "500" } },
    res
  );

  assert.equal(capture.limit, 100);
  assert.equal(capture.skip, 200);
});
