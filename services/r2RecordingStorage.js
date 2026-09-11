// Read existing LiveKit files from a private R2 bucket. Credentials never leave the API.
const { S3Client, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const { createHash } = require("crypto");

function config() {
  return {
    endpoint: process.env.R2_ENDPOINT || process.env.S3_ENDPOINT,
    bucket: process.env.R2_BUCKET || process.env.S3_BUCKET,
    accessKeyId: process.env.R2_ACCESS_KEY_ID || process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || process.env.S3_SECRET_ACCESS_KEY,
  };
}

function configured() {
  const c = config();
  return Boolean(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey);
}

function client() {
  if (!configured()) throw Object.assign(new Error("Recording storage is not configured."), { status: 503 });
  const c = config();
  return new S3Client({
    endpoint: c.endpoint, region: "auto", forcePathStyle: true,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
  });
}

// Only resolve references saved on an authorized session, never a key supplied by a browser.
function objectKey(reference) {
  const value = String(reference || "");
  const c = config();
  if (value.startsWith("r2:")) return validateKey(value.slice(3));
  if (value.startsWith("s3://")) {
    const url = new URL(value);
    if (url.hostname !== c.bucket) throw new Error("Recording bucket does not match configuration.");
    return validateKey(decodeURIComponent(url.pathname.slice(1)));
  }
  if (/^https?:/i.test(value)) {
    const url = new URL(value);
    const endpoint = new URL(c.endpoint);
    if (url.origin !== endpoint.origin || !url.pathname.startsWith(`/${c.bucket}/`)) {
      throw new Error("Recording URL does not belong to the configured bucket.");
    }
    return validateKey(decodeURIComponent(url.pathname.slice(c.bucket.length + 2)));
  }
  return validateKey(value);
}

function validateKey(key) {
  if (!key || key.startsWith("/") || key.includes(":") || key.split("/").some(p => p === ".." || p === ".")) {
    throw new Error("Invalid recording object key.");
  }
  return key;
}

function isR2Recording(ai = {}) {
  const key = String(ai.recordingKey || "");
  if (!key || key.startsWith("cloudinary:")) return false;
  if (key.startsWith("r2:") || key.startsWith("s3://")) return true;
  if (ai.recordingSource === "egress" || ai.egressId) return true;
  // Historical Egress and browser uploads used bare R2 keys. Cloudinary recordings use encoded refs.
  return !/^https?:/i.test(key);
}

async function playback(reference) {
  const s3 = client();
  try {
    const input = { Bucket: config().bucket, Key: objectKey(reference) };
    const file = await s3.send(new HeadObjectCommand(input));
    if (!file.ContentLength) throw Object.assign(new Error("Recording file is empty."), { status: 409 });
    // HLS requires signing every segment as well as the manifest; do not serve a broken playlist.
    const extension = input.Key.split(".").pop().toLowerCase();
    const contentType = { mp4: "video/mp4", webm: "video/webm", m4v: "video/mp4" }[extension];
    if (!contentType) throw Object.assign(new Error("This recording format cannot be played. An MP4 or WebM file is required."), { status: 422 });
    const expiresInSeconds = 900;
    const url = await getSignedUrl(s3, new GetObjectCommand({ ...input, ResponseContentType: contentType, ResponseContentDisposition: "inline" }), { expiresIn: expiresInSeconds });
    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString() };
  } finally { s3.destroy(); }
}

async function deleteRecording(reference) {
  const s3 = client();
  try { await s3.send(new DeleteObjectCommand({ Bucket: config().bucket, Key: objectKey(reference) })); }
  finally { s3.destroy(); }
}

// Older Egress webhooks never saved a key. Recover only the exact tenant/session namespace
// used by that producer; multiple captures are returned for the reviewer to choose explicitly.
async function filesForSession(session) {
  const company = String(session.company || "");
  const id = String(session._id || "");
  if (![company, id].every(value => /^[a-f0-9]{24}$/i.test(value))) throw new Error("Invalid recording session scope.");
  const s3 = client();
  try {
    const prefix = `interview-recordings/${company}/${id}-`;
    const result = await s3.send(new ListObjectsV2Command({ Bucket: config().bucket, Prefix: prefix, MaxKeys: 1000 }));
    if (result.IsTruncated) throw Object.assign(new Error("Too many recording files for this session."), { status: 409 });
    return (result.Contents || []).filter(file => file.Size > 0 && file.Key.startsWith(prefix) && /^\d+\.mp4$/.test(file.Key.slice(prefix.length)))
      .sort((a, b) => a.Key.localeCompare(b.Key))
      .map(file => ({ key: file.Key, id: createHash("sha256").update(file.Key).digest("hex").slice(0, 24),
        recordedAt: new Date(Number(file.Key.slice(prefix.length, -4))).toISOString() }));
  } finally { s3.destroy(); }
}

module.exports = { configured, objectKey, isR2Recording, playback, deleteRecording, filesForSession };
