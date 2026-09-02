const crypto = require("crypto");

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function generateJobSlug(title) {
  const base = slugify(title || "job") || "job";
  const suffix = crypto.randomBytes(3).toString("hex");
  return `${base}-${suffix}`;
}

module.exports = { slugify, generateJobSlug };
