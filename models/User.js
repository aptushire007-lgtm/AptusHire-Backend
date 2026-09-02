const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    phone: { type: String, trim: true },
    passwordHash: { type: String, required: true },
    role: { type: String, enum: ["superadmin", "admin", "candidate"], required: true },
    company: { type: mongoose.Schema.Types.ObjectId, ref: "Company" },

    emailVerified: { type: Boolean, default: false },
    verificationTokenHash: { type: String },
    verificationExpiresAt: { type: Date },

    resetTokenHash: { type: String },
    resetExpiresAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("User", userSchema);
