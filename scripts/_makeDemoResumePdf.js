// One-off: render the golden-set synthetic resume (Rohan Deshpande, clear-pass
// backend-node fixture) into a real PDF so the live apply-form multipart upload
// (which requires a genuine PDF/DOCX magic byte) has a realistic file to work with.
const fs = require("fs");
const path = require("path");
const { PdfDoc } = require("../utils/pdf");

const src = path.join(__dirname, "../test/fixtures/golden/01-clear_pass-senior-node-backend.resume.txt");
const text = fs.readFileSync(src, "utf8");

const doc = new PdfDoc();
for (const rawLine of text.split("\n")) {
  const line = rawLine.trimEnd();
  if (!line) {
    doc.moveDown(8);
    continue;
  }
  const isHeading = line === line.toUpperCase() && /[A-Z]/.test(line) && line.length < 40;
  doc.ensure(16);
  doc.text(line, { size: isHeading ? 12 : 10, bold: isHeading, gap: isHeading ? 4 : 2 });
}

const out = doc.render();
const outPath = path.join(__dirname, "../uploads/_demo-resume-rohan-deshpande.pdf");
fs.writeFileSync(outPath, out);
console.log("Wrote", outPath, `(${out.length} bytes)`);
