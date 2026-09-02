// BoardCredential (BUILD-PLAN Phase 15.5) — a tenant's own job-board account
// credentials (Tier B: they already pay Naukri/Monster/etc.; we post as their
// client tooling). Secrets are AES-256-GCM encrypted at rest with a key from
// env — never stored plaintext, never returned by any API after write, never
// logged, never shared across tenants.

const mongoose = require("mongoose");

const boardCredentialSchema = new mongoose.Schema(
  {
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true },
    board: { type: String, required: true, trim: true, lowercase: true },

    // AES-256-GCM envelope of the JSON credential payload.
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    authTag: { type: String, required: true },

    lastTestedAt: { type: Date },
    lastTestOk: { type: Boolean },
  },
  { timestamps: true }
);

boardCredentialSchema.index({ company: 1, board: 1 }, { unique: true });

boardCredentialSchema.plugin(require("./plugins/tenantScope"));

module.exports = mongoose.model("BoardCredential", boardCredentialSchema);
