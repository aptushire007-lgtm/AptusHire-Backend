const mongoose = require("mongoose");

// Folds the spec's separate "DeliveryStatus" concept into this same document
// (status/attempts/error/sentAt) rather than a second parallel table — one
// email send has exactly one delivery outcome, so tracking it in a sibling
// collection would just require a join back to this one for no benefit.
const emailLogSchema = new mongoose.Schema(
  {
    // Optional tenant tag for per-company audit/filtering. Not tenant-scoped by the
    // plugin (EmailLog has no tenant-facing read path today), but populated when the
    // dispatch context knows the company so it's ready if that changes.
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", index: true },
    to: { type: String, required: true, trim: true, lowercase: true, index: true },
    subject: { type: String, required: true },
    text: { type: String },
    html: { type: String },
    category: { type: String, trim: true, index: true },
    relatedType: { type: String, trim: true },
    relatedId: { type: mongoose.Schema.Types.ObjectId },
    status: { type: String, enum: ["queued", "sent", "retrying", "failed"], default: "queued", index: true },
    attempts: { type: Number, default: 0 },
    error: { type: String },
    sentAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("EmailLog", emailLogSchema);
