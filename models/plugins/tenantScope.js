// Mongoose plugin that enforces tenant (company) isolation as a defense-in-depth
// safety net on top of the explicit `{ _id, company }` filters controllers already use.
//
// When a query runs inside a tenant context (see utils/tenantContext.js):
//   - reads/updates/deletes without an explicit `company` filter get `{ company: <tenantId> }`
//     injected automatically, so a forgotten filter fails safe instead of leaking data.
// When a query runs with NO tenant context:
//   - system jobs (runAsSystem) are trusted and pass through untouched;
//   - otherwise, in strict mode (TENANT_GUARD_STRICT=true) the query throws — use this in
//     staging/CI to surface any tenant-scoped access path that lost its context.
//
// Writes: new tenant-scoped documents must carry a `company`, or save() throws.
//
// Apply ONLY to models that are always accessed within a single tenant. Do NOT apply to
// User / Notification (mixed admin+candidate, company may be null) or global catalogs.

const mongoose = require("mongoose");
const tenantContext = require("../../utils/tenantContext");

const STRICT = process.env.TENANT_GUARD_STRICT === "true";

const QUERY_HOOKS = [
  "count",
  "countDocuments",
  "find",
  "findOne",
  "findOneAndDelete",
  "findOneAndReplace",
  "findOneAndUpdate",
  "replaceOne",
  "updateOne",
  "updateMany",
  "deleteOne",
  "deleteMany",
];

module.exports = function tenantScopePlugin(schema) {
  function scopeQuery() {
    const tenantId = tenantContext.getTenantId();
    if (tenantId) {
      const filter = this.getFilter() || {};
      // Respect an explicit company filter (controllers already scope correctly);
      // only inject when the caller didn't constrain the tenant.
      if (filter.company === undefined) {
        this.where({ company: tenantId });
      }
      return;
    }
    if (tenantContext.isSystem()) return; // trusted background job
    if (STRICT) {
      const model = this.model && this.model.modelName ? this.model.modelName : "unknown";
      throw new Error(`[tenantScope] query on ${model} ran without a tenant context (strict mode)`);
    }
  }

  QUERY_HOOKS.forEach((hook) => schema.pre(hook, scopeQuery));

  schema.pre("aggregate", function () {
    const tenantId = tenantContext.getTenantId();
    if (tenantId) {
      // Aggregation pipelines are never cast against the schema (unlike find/
      // findOne filters), so a raw string here silently matches zero documents
      // against a BSON ObjectId `company` field instead of throwing.
      this.pipeline().unshift({ $match: { company: new mongoose.Types.ObjectId(tenantId) } });
    } else if (!tenantContext.isSystem() && STRICT) {
      throw new Error("[tenantScope] aggregate ran without a tenant context (strict mode)");
    }
  });

  schema.pre("save", function () {
    if (this.isNew && this.company == null) {
      throw new Error(
        `[tenantScope] refusing to save ${this.constructor.modelName} without a company (tenant) reference`
      );
    }
  });
};
