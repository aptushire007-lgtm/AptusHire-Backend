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

function formatForContentType(contentType = "") {
  const formats = {
    "application/pdf": "pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  };
  return formats[String(contentType).toLowerCase()] || "";
}

function encodeReference(result) {
  return `cloudinary:${Buffer.from(JSON.stringify({
    publicId: result.public_id,
    resourceType: result.resource_type,
    deliveryType: result.type || "upload",
    format: result.format || "",
    secureUrl: result.secure_url,
  }), "utf8").toString("base64url")}`;
}

function decodeReference(reference) {
  const value = String(reference || "");
  if (!value.startsWith("cloudinary:")) throw new Error("storage: invalid Cloudinary reference");
  return JSON.parse(Buffer.from(value.slice("cloudinary:".length), "base64url").toString("utf8"));
}

// Legacy Resume/ResumeVersion documents written before encodeReference was
// introduced store a raw Cloudinary public ID (e.g. "resume-library/abc/xyz")
// or a full https:// URL instead of the encoded reference. This normalises
// both shapes into the { publicId, resourceType, secureUrl } record that
// getObjectBuffer and deleteObject need, so old data doesn't crash on apply.
function resolveReference(reference, { contentType } = {}) {
  const value = String(reference || "");
  if (value.startsWith("cloudinary:")) return decodeReference(value);
  // Full https URL stored directly (older upload path)
  if (value.startsWith("https://") || value.startsWith("http://")) {
    return { publicId: null, resourceType: "raw", deliveryType: "upload", secureUrl: value };
  }
  // Raw public ID — reconstruct a download URL via the Cloudinary SDK
  if (configured && value) {
    const hasExtension = /\.[^/.]+$/.test(value);
    const secureUrl = cloudinary.url(value, {
      resource_type: "raw",
      sign_url: true,
      format: hasExtension ? undefined : formatForContentType(contentType),
      secure: true,
    });
    return { publicId: value, resourceType: "raw", deliveryType: "upload", secureUrl };
  }
  throw new Error("storage: invalid Cloudinary reference");
}

function uploadBuffer({ buffer, publicId, contentType }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: resourceType(contentType),
        type: "authenticated",
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

function deliveryUrl(record) {
  if (!record.publicId) return record.secureUrl;
  if (record.deliveryType === "authenticated" && record.publicId) {
    return cloudinary.utils.private_download_url(record.publicId, record.format || undefined, {
      resource_type: record.resourceType,
      type: "authenticated",
      secure: true,
      attachment: false,
    });
  }
  return cloudinary.url(record.publicId || record.secureUrl, {
    resource_type: record.resourceType,
    type: record.deliveryType || "upload",
    secure: true,
    sign_url: Boolean(record.publicId),
    format: record.format || undefined,
  });
}

async function getObjectBuffer(reference, options) {
  if (!configured) throw new Error("Cloudinary storage is not configured");
  const record = resolveReference(reference, options);
  const response = await fetch(deliveryUrl(record), { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Cloudinary download failed with HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function sendDownload(res, reference, filename, contentType) {
  const buffer = await getObjectBuffer(reference, { contentType });
  res.setHeader("Content-Disposition", `attachment; filename="${(filename || "download").replace(/"/g, "")}"`);
  if (contentType) res.setHeader("Content-Type", contentType);
  res.send(buffer);
}

async function deleteObject(reference) {
  if (!reference || !configured) return;
  const record = resolveReference(reference);
  if (!record.publicId) return; // URL-only legacy record — nothing to destroy via API
  await cloudinary.uploader.destroy(record.publicId, { resource_type: record.resourceType, invalidate: true });
}

async function getSignedDownloadUrl(reference) {
  if (!reference || !configured) return null;
  const record = resolveReference(reference);
  return deliveryUrl(record);
}

module.exports = { isEnabled, buildKey, putObject, getObjectBuffer, sendDownload, deleteObject, getSignedDownloadUrl };
