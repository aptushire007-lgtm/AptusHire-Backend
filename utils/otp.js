const crypto = require("crypto");

const OTP_LENGTH = 6;
const OTP_VALIDITY_MINUTES = 10;
const MAX_VERIFY_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 45;
const MAX_SENDS_PER_WINDOW = 5;
const SEND_WINDOW_MINUTES = 60;

function generateOtp() {
  const max = 10 ** OTP_LENGTH;
  const otp = crypto.randomInt(0, max).toString().padStart(OTP_LENGTH, "0");
  return otp;
}

function hashOtp(otp) {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

function computeExpiry() {
  return new Date(Date.now() + OTP_VALIDITY_MINUTES * 60 * 1000);
}

function canResend(record) {
  if (!record) return { allowed: true };

  const secondsSinceLastSend = (Date.now() - new Date(record.lastSentAt).getTime()) / 1000;
  if (secondsSinceLastSend < RESEND_COOLDOWN_SECONDS) {
    return {
      allowed: false,
      reason: `Please wait ${Math.ceil(RESEND_COOLDOWN_SECONDS - secondsSinceLastSend)}s before requesting another code`,
    };
  }

  const windowStart = Date.now() - SEND_WINDOW_MINUTES * 60 * 1000;
  if (new Date(record.createdAt).getTime() > windowStart && record.sendCount >= MAX_SENDS_PER_WINDOW) {
    return { allowed: false, reason: "Too many code requests. Please try again later." };
  }

  return { allowed: true };
}

module.exports = {
  OTP_LENGTH,
  OTP_VALIDITY_MINUTES,
  MAX_VERIFY_ATTEMPTS,
  generateOtp,
  hashOtp,
  computeExpiry,
  canResend,
};
