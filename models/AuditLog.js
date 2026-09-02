const mongoose = require("mongoose");

// Immutable-by-convention audit trail of security-relevant + mutating actions.
// Intentionally NOT tenant-plugin-scoped: it also records platform/superadmin and
// anonymous auth events (login, company registration) that have no company. The
// `company` field is set explicitly where a tenant is known, and reads are filtered
// on it manually (see dataRightsController / any future audit viewer).
const auditLogSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },

    actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    actorRole: { type: String, trim: true },
    actorEmail: { type: String, trim: true },

    // Human-readable action. For request-derived entries this is `${METHOD} ${path}`;
    // explicit security events set a semantic name (e.g. "candidate.erase").
    action: { type: String, required: true, trim: true },
    method: { type: String, trim: true },
    path: { type: String, trim: true },

    // Optional target of the action, set by controllers via `req.audit`.
    resourceType: { type: String, trim: true },
    resourceId: { type: String, trim: true },

    statusCode: { type: Number },
    ip: { type: String, trim: true },
    userAgent: { type: String, trim: true },

    // Structured detail (before/after snapshots, counts, reason) for explicit audits.
    meta: { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditLogSchema.index({ company: 1, createdAt: -1 });
auditLogSchema.index({ actorUserId: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
