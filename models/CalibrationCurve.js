// CalibrationCurve (BUILD-PLAN Phase 10.2) — the nightly-computed, per-tenant
// mapping from score bins to observed advancement rates. DISPLAY-ONLY by hard
// rule: nothing in the scoring path may ever read this collection, and nothing
// here may ever write a rubric. Fitting weights to past outcomes would
// automate past bias — the exact failure mode regulators look for.

const mongoose = require("mongoose");

const binSchema = new mongoose.Schema(
  {
    lo: { type: Number, required: true },  // inclusive
    hi: { type: Number, required: true },  // inclusive
    n: { type: Number, required: true },
    advanced: { type: Number, required: true },
    p: { type: Number, required: true },      // advanced / n
    ciLow: { type: Number, required: true },  // Wilson 95%
    ciHigh: { type: Number, required: true },
  },
  { _id: false }
);

const calibrationCurveSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, unique: true },
    sampleSize: { type: Number, required: true }, // decided outcomes only
    bins: { type: [binSchema], default: [] },
    minTotal: { type: Number, required: true },   // display gates recorded with the curve
    minPerBin: { type: Number, required: true },
    computedAt: { type: Date, required: true },
  },
  { timestamps: true }
);

calibrationCurveSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("CalibrationCurve", calibrationCurveSchema);
