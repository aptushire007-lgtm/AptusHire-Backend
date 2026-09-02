// BILLING_ENFORCEMENT=off — the demo/pilot escape hatch.
//
// The whole point of this flag is that it is reversible with no data migration and
// impossible to enable by accident, so that is what these gates assert:
//   - enforcement is ON for every value except the literal "off" (fail-safe parse);
//   - with it off, requireActiveCompany passes an unpaid AND a suspended tenant,
//     but a MISSING company is still a hard 403 — a dangling tenant reference is a
//     data-integrity fault, not a billing state;
//   - with it on (the default) nothing changes;
//   - activateIfBypassed never rewrites a suspended tenant's status, which is what
//     makes restoring enforcement restore the lockout exactly.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const { billingEnforced, demoPlanKey } = require("../../utils/billingMode");
const { activateIfBypassed } = require("../../services/demoActivationService");
const { requireActiveCompany } = require("../../middleware/auth");
const Company = require("../../models/Company");

const originalFindById = Company.findById;
afterEach(() => {
  Company.findById = originalFindById;
  delete process.env.BILLING_ENFORCEMENT;
  delete process.env.DEMO_PLAN_KEY;
});

function stubCompany(status) {
  Company.findById = () => ({ select: async () => (status === null ? null : { status }) });
}

function fakeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function runGate(status) {
  stubCompany(status);
  const res = fakeRes();
  let passed = false;
  await requireActiveCompany({ user: { company: new mongoose.Types.ObjectId() } }, res, () => {
    passed = true;
  });
  return { passed, res };
}

test("GUARDRAIL: only the literal \"off\" disables enforcement — every other value fails safe", () => {
  const keepsPaywallUp = [undefined, "", " ", "false", "0", "no", "on", "OFFF", "disabled"];
  for (const value of keepsPaywallUp) {
    if (value === undefined) delete process.env.BILLING_ENFORCEMENT;
    else process.env.BILLING_ENFORCEMENT = value;
    assert.equal(billingEnforced(), true, `BILLING_ENFORCEMENT=${JSON.stringify(value)} must keep the paywall up`);
  }

  for (const value of ["off", "OFF", " Off "]) {
    process.env.BILLING_ENFORCEMENT = value;
    assert.equal(billingEnforced(), false, `BILLING_ENFORCEMENT=${JSON.stringify(value)} must disable enforcement`);
  }
});

test("demo plan defaults to the unlimited tier and is overridable", () => {
  assert.equal(demoPlanKey(), "enterprise");
  process.env.DEMO_PLAN_KEY = "starter";
  assert.equal(demoPlanKey(), "starter");
});

test("enforcement ON (default): unpaid and suspended tenants are blocked with COMPANY_INACTIVE", async () => {
  for (const status of ["pending_payment", "pending_verification", "suspended"]) {
    const { passed, res } = await runGate(status);
    assert.equal(passed, false, `${status} must not reach the route`);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.code, "COMPANY_INACTIVE");
    assert.equal(res.body.status, status);
  }

  const active = await runGate("active");
  assert.equal(active.passed, true);
});

test("enforcement OFF: unpaid and suspended tenants pass the gate", async () => {
  process.env.BILLING_ENFORCEMENT = "off";
  for (const status of ["pending_payment", "pending_verification", "suspended", "active"]) {
    const { passed, res } = await runGate(status);
    assert.equal(passed, true, `${status} must reach the route while the bypass is on`);
    assert.equal(res.statusCode, null);
  }
});

test("GUARDRAIL: a missing company is still a hard 403 even with the bypass on", async () => {
  process.env.BILLING_ENFORCEMENT = "off";
  const { passed, res } = await runGate(null);
  assert.equal(passed, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.error, /not found/i);
});

test("GUARDRAIL: the bypass never rewrites a suspended tenant's status", async () => {
  process.env.BILLING_ENFORCEMENT = "off";
  let saved = false;
  const suspended = {
    name: "Acme",
    status: "suspended",
    save: async () => {
      saved = true;
    },
  };

  assert.equal(await activateIfBypassed(suspended), false);
  assert.equal(suspended.status, "suspended", "suspension must survive so restoring the flag restores the lockout");
  assert.equal(saved, false, "no write at all — nothing to migrate back");
});

test("activateIfBypassed is a no-op while billing is enforced, and for already-active tenants", async () => {
  const pending = { name: "Acme", status: "pending_payment", save: async () => {} };
  assert.equal(await activateIfBypassed(pending), false, "enforced: must not activate");
  assert.equal(pending.status, "pending_payment");

  process.env.BILLING_ENFORCEMENT = "off";
  const active = { name: "Acme", status: "active", save: async () => {} };
  assert.equal(await activateIfBypassed(active), false, "already active: nothing to do");
  assert.equal(await activateIfBypassed(null), false, "no company: nothing to do");
});
