// PublishedJob (BUILD-PLAN Phase 15.4) — one row per (job, board) publication.
// The connector framework's source of truth: publish is idempotent per pair
// (re-publish updates the existing externalRef, never creates a duplicate —
// boards de-rank employers who cross-post duplicates), and the UI reads status
// per board so a failure is visible per board, never silent.

const mongoose = require("mongoose");

const publishedJobSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    job: { type: mongoose.Schema.Types.ObjectId, ref: "Job", required: true },
    board: { type: String, required: true, trim: true, lowercase: true },
    tier: { type: String, enum: ["A", "B", "C"], required: true },

    status: {
      type: String,
      enum: ["pending", "published", "failed", "expired", "withdrawn"],
      default: "pending",
    },
    // The board's identifier for this listing — the idempotency anchor.
    externalRef: { type: String, trim: true },
    externalUrl: { type: String, trim: true },
    // Masked driver error (boardCredentialService.maskError) — never raw board output.
    error: { type: String, trim: true, maxlength: 2000 },
    attempts: { type: Number, default: 0 },

    publishedAt: { type: Date },
    withdrawnAt: { type: Date },
    lastSyncedAt: { type: Date },
  },
  { timestamps: true }
);

publishedJobSchema.index({ company: 1, job: 1, board: 1 }, { unique: true });
publishedJobSchema.index({ status: 1, lastSyncedAt: 1 }); // nightly reconcile scan

publishedJobSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("PublishedJob", publishedJobSchema);
