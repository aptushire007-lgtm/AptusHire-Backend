// Per-request tenant context, propagated through async calls via AsyncLocalStorage.
//
// requireAuth() runs the rest of an authenticated request inside run({ companyId, ... }).
// The tenantScope Mongoose plugin (models/plugins/tenantScope.js) reads getTenantId()
// and auto-injects `{ company: <tenantId> }` into every query on a tenant-scoped model,
// so a controller that forgets its company filter still cannot read another tenant's data.
//
// Background jobs (cron, BullMQ workers) legitimately operate across all tenants — they
// run inside runAsSystem(), which marks the context trusted so no tenant filter is applied
// and the strict-mode guard is bypassed.

const { AsyncLocalStorage } = require("async_hooks");

const storage = new AsyncLocalStorage();

// Run `fn` inside a tenant context. `companyId` may be undefined for identities that are
// not tenant-bound (candidate accounts, superadmin) — getTenantId() then returns undefined
// and no tenant filter is injected.
function run(store, fn) {
  return storage.run({ ...store, system: false }, fn);
}

// Run `fn` as a trusted system actor (no tenant scoping, no strict guard).
function runAsSystem(fn) {
  return storage.run({ system: true }, fn);
}

function getStore() {
  return storage.getStore();
}

// The tenant (company) id to scope queries by, or undefined when there is none
// (public/candidate/system contexts).
function getTenantId() {
  const s = storage.getStore();
  if (!s || s.system) return undefined;
  return s.companyId || undefined;
}

function isSystem() {
  const s = storage.getStore();
  return Boolean(s && s.system);
}

module.exports = { run, runAsSystem, getStore, getTenantId, isSystem, storage };
