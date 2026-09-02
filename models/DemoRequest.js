const mongoose = require("mongoose");

// Sales lead from the public "Request a Demo" page. Phase 13 fix: the page used
// to open a mailto: and persist nothing — a closed mail client silently lost the
// lead. Not tenant-scoped: leads arrive before any company exists.
const demoRequestSchema = new mongoose.Schema(
  {
    companyName: { type: String, required: true, trim: true, maxlength: 200 },
    email: { type: String, required: true, trim: true, lowercase: true, maxlength: 320 },
    phone: { type: String, trim: true, maxlength: 40 },
    companySize: { type: String, trim: true, maxlength: 40 },
    message: { type: String, trim: true, maxlength: 5000 },

    status: { type: String, enum: ["new", "contacted", "closed"], default: "new" },
    ip: { type: String, trim: true },
    userAgent: { type: String, trim: true },
  },
  { timestamps: true }
);

demoRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model("DemoRequest", demoRequestSchema);
