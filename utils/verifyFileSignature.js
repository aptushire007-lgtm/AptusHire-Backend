const PDF_SIGNATURE = Buffer.from("25504446", "hex");
const ZIP_SIGNATURE = Buffer.from("504b0304", "hex");
const JPEG_SIGNATURE = Buffer.from("ffd8ff", "hex");
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const JPEG_MIME = "image/jpeg";
const PNG_MIME = "image/png";

/**
 * Detects the real file type from its content (magic bytes), ignoring
 * whatever Content-Type the client claimed — that header is client-supplied
 * and not trustworthy for a security decision.
 * Returns the canonical mime type, or null if it's neither a PDF nor a DOCX.
 */
function detectFileType(buffer) {
  if (buffer.subarray(0, 4).equals(PDF_SIGNATURE)) return PDF_MIME;
  if (buffer.subarray(0, 4).equals(ZIP_SIGNATURE)) return DOCX_MIME;
  return null;
}

function detectImageType(buffer) {
  if (buffer.subarray(0, 3).equals(JPEG_SIGNATURE)) return JPEG_MIME;
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return PNG_MIME;
  return null;
}

module.exports = { detectFileType, detectImageType, PDF_MIME, DOCX_MIME, JPEG_MIME, PNG_MIME };
