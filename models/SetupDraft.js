const mongoose = require("mongoose");
const { EMPTY, STEPS } = require("../utils/setupDraft");

const schema = new mongoose.Schema({
  company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  schemaVersion: { type: Number, default: 1, enum: [1] },
  clientKey: { type: String, required: true },
  revision: { type: Number, default: 1, min: 1 },
  currentStep: { type: String, enum: STEPS, default: "role" },
  source: { type: String, enum: ["description", "title"], default: "description" },
  values: { type: new mongoose.Schema(Object.fromEntries(Object.keys(EMPTY).map(name => [name, { type: String, default: EMPTY[name] }])), { _id: false }), default: () => ({ ...EMPTY }) },
  state: { type: String, enum: ["editing", "creating", "linked"], default: "editing" },
  reservedJobId: { type: mongoose.Schema.Types.ObjectId, required: true, default: () => new mongoose.Types.ObjectId() },
  job: { type: mongoose.Schema.Types.ObjectId, ref: "Job" },
  lastMutation: { key: String, digest: String },
  journeyReview: { fingerprint: String, reviewedAt: Date, reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" } },
}, { timestamps: true });
schema.index({ company: 1, owner: 1, clientKey: 1 }, { unique: true });
schema.index({ company: 1, owner: 1, updatedAt: -1, _id: -1 });
schema.index({ company: 1, job: 1, owner: 1 });
schema.plugin(require("./plugins/tenantScope"));
module.exports = mongoose.model("SetupDraft", schema);
