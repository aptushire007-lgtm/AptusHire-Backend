#!/usr/bin/env node

// Read-only inventory for legacy Cloudinary references. URL-only upload assets
// can reveal a public ID, but that does not make the existing asset private;
// changing delivery mode requires a credentialed Cloudinary migration.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Resume = require("../models/Resume");
const ResumeVersion = require("../models/ResumeVersion");
const GovDocument = require("../models/GovDocument");
const InterviewSession = require("../models/InterviewSession");

const SOURCES = [
  { name: "Resume.filePath", model: Resume, field: "filePath", query: { filePath: { $exists: true, $ne: "" } } },
  { name: "ResumeVersion.filePath", model: ResumeVersion, field: "filePath", query: { filePath: { $exists: true, $ne: "" } } },
  { name: "GovDocument.filePath", model: GovDocument, field: "filePath", query: { filePath: { $exists: true, $ne: "" } } },
  { name: "GovDocument.fileUrl", model: GovDocument, field: "fileUrl", query: { fileUrl: { $exists: true, $ne: "" } } },
];

function parseCloudinaryUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!url.hostname.endsWith(".cloudinary.com")) return null;
  const match = url.pathname.match(/\/(image|video|raw)\/(upload|authenticated|private)\/(.*)$/i);
  if (!match) return null;

  const resourceType = match[1].toLowerCase() === "image" ? "image" : match[1].toLowerCase() === "video" ? "video" : "raw";
  const deliveryType = match[2].toLowerCase();
  const tail = match[3].split("/");
  while (tail.length && (/^v\d+$/.test(tail[0]) || /^[a-z][a-z0-9_,:-]*$/.test(tail[0]) && !tail[0].includes("."))) {
    if (/^v\d+$/.test(tail[0])) {
      tail.shift();
      break;
    }
    // Transformation segments are before the version/public ID. Keep a segment
    // containing a dot as the first plausible public-ID segment.
    if (tail.length === 1 || tail[0].includes("/")) break;
    tail.shift();
  }
  const publicIdWithFormat = tail.join("/");
  if (!publicIdWithFormat) return null;
  const extension = path.extname(publicIdWithFormat).slice(1);
  return {
    publicId: extension ? publicIdWithFormat.slice(0, -(extension.length + 1)) : publicIdWithFormat,
    format: extension,
    resourceType,
    deliveryType,
    sourceUrl: value,
    secureMigration: deliveryType === "authenticated" ? "reference_only" : "requires_cloudinary_access_mode_change_or_reupload",
  };
}

function classify(value) {
  const text = String(value || "");
  if (text.startsWith("cloudinary:")) return { kind: "secure_reference", migratable: false };
  const parsed = parseCloudinaryUrl(text);
  if (parsed) return { kind: "legacy_cloudinary_url", migratable: false, cloudinary: parsed };
  if (text && !/^https?:\/\//i.test(text)) {
    return {
      kind: "legacy_public_id",
      migratable: true,
      cloudinary: { publicId: text, resourceType: "raw", deliveryType: "upload", format: "" },
    };
  }
  return { kind: "unknown_reference", migratable: false };
}

async function main() {
  const outputPath = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : null;
  await connectDB();
  const records = [];

  for (const source of SOURCES) {
    const docs = await source.model.find(source.query).select(`_id ${source.field}`).lean();
    for (const doc of docs) {
      const value = doc[source.field];
      const classification = classify(value);
      if (classification.kind === "secure_reference") continue;
      records.push({
        model: source.model.modelName,
        field: source.field,
        id: String(doc._id),
        value,
        ...classification,
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    dryRun: true,
    mutated: false,
    records,
    nextStep: "Review legacy_cloudinary_url records in staging. Recoverable public IDs still require a credentialed Cloudinary access-mode change or re-upload before replacing database references. This utility never mutates records or deletes assets.",
  };
  const json = JSON.stringify(report, null, 2);
  if (outputPath) fs.writeFileSync(path.resolve(outputPath), json + "\n", "utf8");
  else process.stdout.write(json + "\n");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(`[cloudinary-legacy] ${err.message}`);
  try { await mongoose.disconnect(); } catch {}
  process.exitCode = 1;
});
