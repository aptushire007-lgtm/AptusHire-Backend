const mongoose = require("mongoose");

const otpVerificationSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, trim: true, lowercase: true },
    purpose: { type: String, enum: ["company_registration"], required: true },

    otpHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },

    attempts: { type: Number, default: 0 },
    sendCount: { type: Number, default: 1 },
    lastSentAt: { type: Date, default: Date.now },

    verified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Registration flow reads the latest OTP record for an email+purpose on every verify/resend
// (companyRegistrationService). Replaces the redundant single-field email index.
otpVerificationSchema.index({ email: 1, purpose: 1, createdAt: -1 });

module.exports = mongoose.model("OTPVerification", otpVerificationSchema);
