const crypto = require("crypto");

const VERIFICATION_TOKEN_VALIDITY_HOURS = 24;
const RESET_TOKEN_VALIDITY_MINUTES = 30;
const REFRESH_TOKEN_VALIDITY_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS) || 30;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateVerificationToken() {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_VALIDITY_HOURS * 60 * 60 * 1000);
  return { token, tokenHash: hashToken(token), expiresAt };
}

function generateResetToken() {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_VALIDITY_MINUTES * 60 * 1000);
  return { token, tokenHash: hashToken(token), expiresAt };
}

// Opaque, high-entropy refresh token (stored only as a hash). `family` groups a rotation
// lineage so reuse of a rotated token can revoke every descendant in one shot.
function generateRefreshToken() {
  const token = crypto.randomBytes(48).toString("hex");
  const family = crypto.randomBytes(16).toString("hex");
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  return { token, tokenHash: hashToken(token), family, expiresAt };
}

module.exports = { hashToken, generateVerificationToken, generateResetToken, generateRefreshToken };
