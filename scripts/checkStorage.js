#!/usr/bin/env node
// Proves the configured object store actually works, before a deploy depends on it.
//
// Object storage is the one dependency whose misconfiguration is SILENT: with the S3_*
// vars unset or wrong, storageService falls back to local disk, uploads "succeed", and
// then screening extracts empty text and scores a candidate on nothing. config/env.js
// catches the unset case at boot — it cannot catch a typo'd endpoint, a token scoped to
// the wrong bucket, or a bucket that was never created. This does, in about a second.
//
//   npm run check:storage
//
// It exercises the REAL storageService, not a parallel S3 client, so a pass here means
// the exact code path production uses works against these credentials.
//
// Exit codes: 0 = round-trip OK · 1 = storage is broken or would fall back to disk.

require("dotenv").config();

const crypto = require("crypto");
const storage = require("../services/storageService");

// Common failures, matched on what the SDK actually throws. Each one names the specific
// env var to look at — "AccessDenied" on its own has sent people hunting for hours.
const HINTS = [
  [
    /Invalid URL/i,
    "S3_ENDPOINT is not a URL. It needs the scheme and full hostname — https://<ACCOUNT_ID>.r2.cloudflarestorage.com for R2 (a bare account ID pasted from the dashboard fails exactly this way), or http://127.0.0.1:9100 for local MinIO.",
  ],
  [
    /NoSuchBucket|The specified bucket does not exist/i,
    "The bucket does not exist. R2 does not create it for you — make it in the Cloudflare dashboard (R2 → Create bucket) and check S3_BUCKET matches its name exactly.",
  ],
  [
    /InvalidAccessKeyId|SignatureDoesNotMatch|Unauthorized|401/i,
    "Credentials rejected. Re-check S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY. On R2 these come from 'Manage R2 API Tokens' — they are NOT your Cloudflare global API key, and the secret is shown only once at creation.",
  ],
  [
    /AccessDenied|403/i,
    "Authenticated but not permitted. The R2 API token needs 'Object Read & Write' on this bucket — a token scoped to a different bucket authenticates fine and then denies every operation.",
  ],
  [
    /ENOTFOUND|EAI_AGAIN|getaddrinfo/i,
    "Endpoint hostname did not resolve. S3_ENDPOINT should be https://<ACCOUNT_ID>.r2.cloudflarestorage.com — the account ID, not the bucket name, and no bucket in the path.",
  ],
  [
    /ECONNREFUSED/i,
    "Connection refused. If this is MinIO, the container is not running or S3_ENDPOINT points at the wrong port (the compose file maps MinIO's S3 API to :9100 locally, because the backend owns :9000).",
  ],
  [
    /certificate|SSL|TLS/i,
    "TLS failure. Against MinIO over a private network use http://, not https:// — internal traffic is not TLS terminated.",
  ],
];

function hintFor(err) {
  const text = `${err?.name || ""} ${err?.message || ""} ${err?.Code || ""}`;
  for (const [pattern, hint] of HINTS) if (pattern.test(text)) return hint;
  return null;
}

async function main() {
  const bucket = process.env.S3_BUCKET;
  const endpoint = process.env.S3_ENDPOINT || "(none — AWS S3 default)";

  if (!storage.isEnabled()) {
    const missing = ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter((k) => !process.env[k]);
    console.error("[checkStorage] Object storage is NOT enabled — the app would write to local disk.");
    console.error(`[checkStorage] Missing: ${missing.join(", ")}`);
    console.error(
      "[checkStorage] All three are required together. A partial config falls back to disk exactly as an empty one does,\n" +
        "               which on an ephemeral host destroys every uploaded resume on the next deploy."
    );
    process.exit(1);
  }

  console.log("[checkStorage] bucket        " + bucket);
  console.log("[checkStorage] endpoint      " + endpoint);
  console.log("[checkStorage] region        " + (process.env.S3_REGION || "us-east-1 (default)"));
  console.log("[checkStorage] path-style    " + (process.env.S3_FORCE_PATH_STYLE === "true"));
  console.log("");

  // Written under the same folder convention real objects use, so a bucket policy or
  // lifecycle rule that would break production breaks this check too.
  const key = storage.buildKey("healthcheck", { prefix: "checkstorage" });
  const payload = Buffer.from(`checkStorage ${new Date().toISOString()} ${crypto.randomUUID()}`, "utf8");
  let wrote = false;

  try {
    await storage.putObject({ buffer: payload, key, contentType: "text/plain" });
    wrote = true;
    console.log("[checkStorage] write   OK   " + key);

    const back = await storage.getObjectBuffer(key);
    if (!back.equals(payload)) {
      console.error("[checkStorage] read    FAIL — object came back with different bytes than were written.");
      process.exit(1);
    }
    console.log(`[checkStorage] read    OK   ${back.length} bytes, identical`);

    await storage.deleteObject(key);
    wrote = false;
    console.log("[checkStorage] delete  OK");

    console.log("\n[checkStorage] PASS — put/get/delete all work against this bucket.");
  } catch (err) {
    console.error(`\n[checkStorage] FAILED on ${wrote ? "read/delete" : "write"}: ${err.name || "Error"}: ${err.message}`);
    const hint = hintFor(err);
    if (hint) console.error(`\n[checkStorage] Likely cause:\n               ${hint}`);
    // Leave no litter behind if the failure happened after a successful write.
    if (wrote) {
      try {
        await storage.deleteObject(key);
      } catch {
        console.error(`[checkStorage] Note: test object ${key} may still be in the bucket — delete it by hand.`);
      }
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[checkStorage] unexpected error:", err);
  process.exit(1);
});
