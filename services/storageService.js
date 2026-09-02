// Pluggable file storage. Two backends, chosen by env — the same graceful-degradation
// pattern the codebase uses for Redis/SMTP:
//
//   - S3 / MinIO (production, multi-instance): set S3_BUCKET + S3_ACCESS_KEY_ID +
//     S3_SECRET_ACCESS_KEY (+ S3_ENDPOINT + S3_FORCE_PATH_STYLE=true for MinIO).
//     All app instances then read/write the same bucket — fixing the local-disk
//     "file invisible to other instances / ATS scores empty text" defect (F4).
//   - Local disk (dev / single node, default): files live under backend/uploads.
//
// Records store a provider-relative KEY (e.g. "resumes/<companyId>/<rand>.pdf"). Legacy
// rows hold an absolute disk path from the old multer diskStorage — getObjectBuffer()
// still reads those in local mode, so no data migration is required to deploy this.

const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const LOCAL_ROOT = path.join(__dirname, "..", "uploads");

const S3_BUCKET = process.env.S3_BUCKET;
const S3_ENABLED = Boolean(S3_BUCKET && process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY);

let s3Client = null;
let S3Commands = null;

function getS3() {
  if (!S3_ENABLED) return null;
  if (!s3Client) {
    // Lazy require so local-dev without the SDK configured never pays for it.
    const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
    S3Commands = { PutObjectCommand, GetObjectCommand, DeleteObjectCommand };
    s3Client = new S3Client({
      region: process.env.S3_REGION || "us-east-1",
      endpoint: process.env.S3_ENDPOINT || undefined, // required for MinIO, omitted for AWS
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true", // MinIO needs path-style
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID,
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      },
    });
  }
  return s3Client;
}

function isEnabled() {
  return S3_ENABLED;
}

// A relative, tenant-partitioned storage key. `folder` groups by kind (resumes,
// resume-library, identity-photos); `company` partitions by tenant when known so
// cross-tenant object access is structurally impossible.
function buildKey(folder, { company, originalName, prefix } = {}) {
  const ext = originalName ? path.extname(originalName).toLowerCase() : "";
  const rand = crypto.randomBytes(16).toString("hex");
  const name = `${prefix ? prefix + "-" : ""}${rand}${ext}`;
  return company ? `${folder}/${String(company)}/${name}` : `${folder}/${name}`;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Resolve a stored reference to an absolute local path. Handles both new relative
// keys and legacy absolute paths written by the old diskStorage.
function localPathFor(ref) {
  return path.isAbsolute(ref) ? ref : path.join(LOCAL_ROOT, ref);
}

// Persist a buffer and return the KEY to store on the record.
async function putObject({ buffer, key, contentType }) {
  if (S3_ENABLED) {
    const s3 = getS3();
    await s3.send(
      new S3Commands.PutObjectCommand({ Bucket: S3_BUCKET, Key: key, Body: buffer, ContentType: contentType })
    );
    return key;
  }
  const full = localPathFor(key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer);
  return key;
}

async function getObjectBuffer(ref) {
  if (!ref) throw new Error("storage: missing object reference");
  // Relative keys in S3 mode come from the bucket; absolute (legacy) paths always
  // come from local disk.
  if (S3_ENABLED && !path.isAbsolute(ref)) {
    const s3 = getS3();
    const out = await s3.send(new S3Commands.GetObjectCommand({ Bucket: S3_BUCKET, Key: ref }));
    return streamToBuffer(out.Body);
  }
  return fs.readFile(localPathFor(ref));
}

// Stream a stored object to an Express response as a download.
async function sendDownload(res, ref, filename, contentType) {
  const buffer = await getObjectBuffer(ref);
  res.setHeader("Content-Disposition", `attachment; filename="${(filename || "download").replace(/"/g, "")}"`);
  if (contentType) res.setHeader("Content-Type", contentType);
  res.send(buffer);
}

async function deleteObject(ref) {
  if (!ref) return;
  if (S3_ENABLED && !path.isAbsolute(ref)) {
    const s3 = getS3();
    await s3.send(new S3Commands.DeleteObjectCommand({ Bucket: S3_BUCKET, Key: ref }));
    return;
  }
  await fs.rm(localPathFor(ref), { force: true });
}

// Raw S3 credentials/config, for the one caller that needs to hand them to a THIRD PARTY rather
// than use them itself: LiveKit Egress writes a recording directly to this bucket server-side
// (services/livekitService.js), so it needs its own S3Upload client config, not a request routed
// through putObject. Kept here rather than read a second time from env at the call site, so there
// is exactly one place these credentials are read from. Returns null when S3 isn't configured —
// Egress cannot write to local disk, so a caller that gets null has nothing to fall back to.
function s3EgressConfig() {
  if (!S3_ENABLED) return null;
  return {
    bucket: S3_BUCKET,
    accessKey: process.env.S3_ACCESS_KEY_ID,
    secret: process.env.S3_SECRET_ACCESS_KEY,
    region: process.env.S3_REGION || "us-east-1",
    endpoint: process.env.S3_ENDPOINT || "",
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
  };
}

// A time-limited URL the BROWSER can fetch directly, with Range support — unlike getObjectBuffer,
// which loads the whole object into server memory and has no Range story. Only meaningful in S3
// mode: local-disk dev has no signed-URL concept, and a full interview recording (unlike the
// existing 6MB evidence-clip cap) is the wrong size class to buffer through this process anyway.
async function getSignedDownloadUrl(key, { expiresInSeconds = 900 } = {}) {
  if (!S3_ENABLED || !key) return null;
  const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
  const s3 = getS3();
  return getSignedUrl(s3, new S3Commands.GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), {
    expiresIn: expiresInSeconds,
  });
}

module.exports = {
  isEnabled,
  buildKey,
  putObject,
  getObjectBuffer,
  sendDownload,
  deleteObject,
  s3EgressConfig,
  getSignedDownloadUrl,
};
