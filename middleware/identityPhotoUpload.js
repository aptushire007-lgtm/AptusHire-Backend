const multer = require("multer");

const storage = multer.memoryStorage();

const identityPhotoUpload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
});

module.exports = identityPhotoUpload;
