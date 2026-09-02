const mongoose = require("mongoose");

const workspaceSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, unique: true },
    workspaceId: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ["active", "suspended"], default: "active" },
  },
  { timestamps: true }
);

workspaceSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("Workspace", workspaceSchema);
