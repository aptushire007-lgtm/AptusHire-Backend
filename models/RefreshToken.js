const mongoose = require("mongoose");

// Rotating refresh tokens for User accounts (admins + candidate dashboard accounts).
// Only the SHA-256 hash of the raw token is stored — a DB leak doesn't yield usable
// tokens. Each login starts a token "family"; rotation issues a new token in the same
// family and revokes the old one. Presenting an already-rotated (revoked) token is a
// reuse signal (stolen token) → the whole family is revoked. NOT tenant-scoped: it keys
// on the User, which may be an admin (has a company) or a candidate account (no company).
const refreshTokenSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true, index: true },
    family: { type: String, required: true, index: true },

    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date },
    replacedByHash: { type: String },

    userAgent: { type: String, trim: true },
    ip: { type: String, trim: true },
  },
  { timestamps: true }
);

// Auto-purge expired tokens so the collection can't grow unbounded.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("RefreshToken", refreshTokenSchema);
