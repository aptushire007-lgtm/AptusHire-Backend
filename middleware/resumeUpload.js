const path = require("path");
const multer = require("multer");

const ALLOWED_EXTENSIONS = new Set([".pdf", ".docx"]);

const storage = multer.memoryStorage();

const resumeUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      return cb(new Error("Only PDF or DOCX resumes are allowed"));
    }
    cb(null, true);
  },
});

module.exports = resumeUpload;
