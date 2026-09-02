const mongoose = require("mongoose");

// Extraction artifacts (utils/extractResumeText) — the hostility inputs the
// defense pass needs. Persisted so autofill can run the SAME defense analysis
// the ATS runs, without re-parsing the file. Re-parsing would re-normalise the
// text and silently invalidate every stored offset.
const artifactsSchema = new mongoose.Schema(
  {
    invisibleChars: { type: Number, default: 0 },
    controlChars: { type: Number, default: 0 },
    tinyFontChars: { type: Number, default: 0 },
    textLayerChars: { type: Number, default: 0 },
    tinyFontSamples: { type: [String], default: [] },
    pageCount: { type: Number },
  },
  { _id: false }
);

// Cached autofill suggestions for this résumé. Keyed on (textHash, version,
// promptVersion): any of them changing means the cached suggestions no longer
// describe what the current pipeline would produce, so it is recomputed rather
// than served stale. Cheap by design — a candidate reopening the apply form, or
// applying to a second job with the same file, must not re-spend an LLM call.
const autofillCacheSchema = new mongoose.Schema(
  {
    textHash: { type: String },
    version: { type: String },
    promptVersion: { type: String },
    // "ai" = LLM extraction ran; "deterministic" = no-key/disabled fallback that
    // found contact details only. Surfaced to the candidate verbatim — a degraded
    // parse is never rendered as if it were the full thing (engineering rule 5).
    engine: { type: String, enum: ["ai", "deterministic"] },
    payload: { type: mongoose.Schema.Types.Mixed },
    at: { type: Date },
  },
  { _id: false }
);

const resumeSchema = new mongoose.Schema(
  {
    candidateEmail: { type: String, required: true, trim: true, lowercase: true, index: true },
    originalName: { type: String, required: true },
    storedFileName: { type: String, required: true },
    filePath: { type: String, required: true },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    // sha256 of the FILE BYTES — the upload dedupe key.
    checksum: { type: String, required: true, index: true },
    extractedText: { type: String, default: "" },
    // sha256 of the canonical extracted TEXT — a different key from `checksum`
    // (two different files can normalise to identical text). This is the one
    // that matches Candidate.resumeHash and the ClaimGraph reuse key, so
    // autofill and screening provably operate on the same coordinate space.
    textHash: { type: String, default: "", index: true },
    // Canonical offsets where a new page starts; feeds textNormalize.buildBlocks.
    pageBreaks: { type: [Number], default: [] },
    artifacts: { type: artifactsSchema, default: () => ({}) },
    autofill: { type: autofillCacheSchema },
    extractionStatus: {
      type: String,
      enum: ["success", "empty", "failed"],
      default: "success",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Resume", resumeSchema);
