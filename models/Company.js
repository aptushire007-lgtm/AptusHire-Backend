const mongoose = require("mongoose");

const companySchema = new mongoose.Schema(
  {
    companyCode: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true, trim: true, unique: true },
    // Phase 15.2 — public careers-page slug (/careers/:slug). Generated lazily
    // on first use; renames must push the old slug into previousSlugs so every
    // already-published link keeps resolving (301 to the canonical URL).
    slug: { type: String, unique: true, sparse: true, index: true },
    previousSlugs: { type: [String], default: [] },
    logoPath: { type: String },
    industry: { type: String, trim: true },
    companySize: {
      type: String,
      enum: ["1-10", "11-50", "51-200", "201-500", "500+"],
      required: true,
    },
    website: { type: String, trim: true },
    gstNumber: { type: String, trim: true },
    country: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    address: { type: String, required: true, trim: true },

    status: {
      type: String,
      enum: ["pending_verification", "pending_payment", "active", "suspended"],
      default: "pending_verification",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Company", companySchema);
