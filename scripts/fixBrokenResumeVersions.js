// One-time fix: removes ResumeVersion documents whose filePath is not a valid
// encoded Cloudinary reference (raw public IDs / empty strings / local paths
// written by the old ensureVersionsMigrated before the filePath filter was added).
// These documents cause "Cloudinary download failed with HTTP 404" on apply.
//
//   cd "aptus backend" && node scripts/fixBrokenResumeVersions.js
//
// Safe to re-run. Only deletes versions with broken filePaths that have never
// been used in an application (applyCount === 0). Versions used in real
// applications are left untouched.

require("dotenv").config();
const mongoose = require("mongoose");
const ResumeVersion = require("../models/ResumeVersion");

async function main() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI not set");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });

  // Find all versions whose filePath is NOT a valid encoded reference
  const broken = await ResumeVersion.find({
    applyCount: { $in: [0, null] },
    $or: [
      { filePath: { $exists: false } },
      { filePath: "" },
      { filePath: { $not: /^cloudinary:/ } },
    ],
  }).select("_id candidateEmail filePath label applyCount");

  if (broken.length === 0) {
    console.log("No broken ResumeVersion documents found. Nothing to do.");
    await mongoose.disconnect();
    return;
  }

  console.log(`Found ${broken.length} broken ResumeVersion document(s):\n`);
  for (const v of broken) {
    console.log(`  id=${v._id}  email=${v.candidateEmail}  label="${v.label}"  filePath="${v.filePath}"`);
  }

  const ids = broken.map((v) => v._id);
  const result = await ResumeVersion.deleteMany({ _id: { $in: ids } });
  console.log(`\nDeleted ${result.deletedCount} broken ResumeVersion document(s).`);
  console.log("Candidates will be prompted to upload a fresh resume on their next apply.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
