const mongoose = require("mongoose");

const ocrExtractedSchema = new mongoose.Schema(
  {
    fullName: { type: String, trim: true },
    dob: { type: String, trim: true },
    docNumberMasked: { type: String, trim: true },
    confidence: { type: Number, min: 0, max: 1 },
    rawOcr: { type: mongoose.Schema.Types.Mixed },
  },
  { _id: false }
);

const govDocumentSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    docType: {
      type: String,
      enum: ["aadhaar", "passport", "driving_license", "pan", "national_id"],
      required: true,
    },
    maskedNumber: { type: String, required: true },
    fileUrl: { type: String, required: true },
    filePath: { type: String },
    ocrData: { type: ocrExtractedSchema },

    status: {
      type: String,
      enum: ["pending", "verified", "failed", "human_review"],
      default: "pending",
      index: true,
    },
    verifiedBy: { type: String, enum: ["ai_ocr", "human_reviewer", "admin"], default: "ai_ocr" },
    failureReason: { type: String, trim: true },
    verifiedAt: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("GovDocument", govDocumentSchema);
