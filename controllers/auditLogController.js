const AuditLog = require("../models/AuditLog");

// Phase 13 — first read path for AuditLog (written on every mutation since
// Phase 0.5, previously write-only). Company-scoped: an admin sees only their
// own tenant's trail. The platform-wide (cross-tenant) viewer is the Phase 16
// superadmin console, not this endpoint.
async function listCompanyAuditLogs(req, res) {
  if (!req.user.company) {
    return res.status(400).json({ error: "This account is not associated with a company" });
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));

  const filter = { company: req.user.company };

  if (req.query.action) {
    // Prefix match on the action name, with regex metacharacters neutralised —
    // the value is user input.
    const escaped = String(req.query.action).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.action = { $regex: `^${escaped}`, $options: "i" };
  }
  if (req.query.actorEmail) {
    filter.actorEmail = String(req.query.actorEmail).trim().toLowerCase();
  }
  if (req.query.from || req.query.to) {
    filter.createdAt = {};
    if (req.query.from) {
      const from = new Date(req.query.from);
      if (!Number.isNaN(from.getTime())) filter.createdAt.$gte = from;
    }
    if (req.query.to) {
      const to = new Date(req.query.to);
      if (!Number.isNaN(to.getTime())) {
        to.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = to;
      }
    }
    if (Object.keys(filter.createdAt).length === 0) delete filter.createdAt;
  }

  const [items, total] = await Promise.all([
    AuditLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("-__v")
      .lean(),
    AuditLog.countDocuments(filter),
  ]);

  res.json({ items, total, page, limit });
}

module.exports = { listCompanyAuditLogs };
