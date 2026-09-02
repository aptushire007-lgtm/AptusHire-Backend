// Centralized Cloudinary storage for resumes, documents, images, audio, and video.
// References stored in Mongo are opaque Cloudinary records so callers can keep
// using the existing put/get/delete interface without handling provider details.

const path = require("path");
const { Readable } = require("stream");
const cloudinary = require("cloudinary").v2;

const configured = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET
);

if (configured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

function isEnabled() {
  return configured;
}

function buildKey(folder, { company, originalName, prefix } = {}) {
  const ext = originalName ? path.extname(originalName).toLowerCase() : "";
  const rand = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
  const name = `${prefix ? `${prefix}-` : ""}${rand}${ext}`;
  return company ? `${folder}/${String(company)}/${name}` : `${folder}/${name}`;
}

function resourceType(contentType = "") {
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/") || contentType.startsWith("audio/")) return "video";
  return "raw";
}

function publicIdFor(key) {
  return String(key).replace(/\.[^/.]+$/, "");
}

function encodeReference(result) {
  return `cloudinary:${Buffer.from(JSON.stringify({
    publicId: result.public_id,
    resourceType: result.resource_type,
    format: result.format || "",
    secureUrl: result.secure_url,
  }), "utf8").toString("base64url")}`;
}

function decodeReference(reference) {
  const value = String(reference || "");
  if (!value.startsWith("cloudinary:")) throw new Error("storage: invalid Cloudinary reference");
  return JSON.parse(Buffer.from(value.slice("cloudinary:".length), "base64url").toString("utf8"));
}

function uploadBuffer({ buffer, publicId, contentType }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: resourceType(contentType),
        overwrite: false,
        use_filename: false,
        unique_filename: false,
      },
      (error, result) => (error ? reject(error) : resolve(result))
    );
    Readable.from(buffer).pipe(stream);
  });
}

async function putObject({ buffer, key, contentType }) {
  if (!configured) throw new Error("Cloudinary storage is not configured");
  const result = await uploadBuffer({ buffer, publicId: publicIdFor(key), contentType });
  return encodeReference(result);
}

async function getObjectBuffer(reference) {
  if (!configured) throw new Error("Cloudinary storage is not configured");
  const record = decodeReference(reference);
  const response = await fetch(record.secureUrl);
  if (!response.ok) throw new Error(`Cloudinary download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function sendDownload(res, reference, filename, contentType) {
  const buffer = await getObjectBuffer(reference);
  res.setHeader("Content-Disposition", `attachment; filename="${(filename || "download").replace(/"/g, "")}"`);
  if (contentType) res.setHeader("Content-Type", contentType);
  res.send(buffer);
}

async function deleteObject(reference) {
  if (!reference || !configured) return;
  const record = decodeReference(reference);
  await cloudinary.uploader.destroy(record.publicId, { resource_type: record.resourceType, invalidate: true });
}

async function getSignedDownloadUrl(reference) {
  if (!reference || !configured) return null;
  return decodeReference(reference).secureUrl;
}

module.exports = { isEnabled, buildKey, putObject, getObjectBuffer, sendDownload, deleteObject, getSignedDownloadUrl };
