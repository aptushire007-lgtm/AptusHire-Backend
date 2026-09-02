#!/usr/bin/env node
// Verify the configured Cloudinary account can upload, download, and delete an object.

require("dotenv").config();

const crypto = require("crypto");
const storage = require("../services/storageService");

async function main() {
  if (!storage.isEnabled()) {
    console.error("[checkStorage] Cloudinary is not configured — set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.");
    process.exit(1);
  }

  const key = storage.buildKey("healthcheck", { prefix: "checkstorage", originalName: ".txt" });
  const payload = Buffer.from(`checkStorage ${new Date().toISOString()} ${crypto.randomUUID()}`, "utf8");
  let reference;

  try {
    reference = await storage.putObject({ buffer: payload, key, contentType: "text/plain" });
    console.log("[checkStorage] upload OK");
    const back = await storage.getObjectBuffer(reference);
    if (!back.equals(payload)) throw new Error("downloaded object differs from uploaded bytes");
    console.log("[checkStorage] download OK");
    const url = await storage.getSignedDownloadUrl(reference);
    if (!/^https:\/\//.test(url)) throw new Error("Cloudinary URL is not HTTPS");
    console.log("[checkStorage] URL OK");
    await storage.deleteObject(reference);
    console.log("[checkStorage] delete OK");
    console.log("[checkStorage] PASS — Cloudinary upload/download/delete all work.");
  } catch (err) {
    console.error(`[checkStorage] FAILED: ${err.name || "Error"}: ${err.message}`);
    if (reference) {
      try { await storage.deleteObject(reference); } catch { /* best effort cleanup */ }
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[checkStorage] unexpected error:", err);
  process.exit(1);
});
