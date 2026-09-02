const path = require("path");
const multer = require("multer");

// Memory storage so the file buffer can be handed to storageService (S3/MinIO in
// production, local disk in dev). Avoids the multi-instance defect where a file
// written to one instance's local disk is invisible to the others.
// .doc (legacy Word) is rejected AT UPLOAD: no extractor supports it, so it used
// to be accepted here and then silently scored as empty text — an auto-fail with
// no signal to anyone. Better an honest error the candidate can act on.
const allowedTypes = new Set([".pdf", ".docx"]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext === ".doc") {
      return cb(new Error("Legacy .doc files can't be read — please save your resume as PDF or DOCX and re-upload"));
    }
    if (!allowedTypes.has(ext)) {
      return cb(new Error("Only PDF or DOCX resumes are allowed (max 5 MB)"));
    }
    cb(null, true);
  },
});

module.exports = upload;
