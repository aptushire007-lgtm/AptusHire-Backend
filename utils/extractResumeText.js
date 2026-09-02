// Span-addressable résumé extraction (BUILD-PLAN Phase 4.1).
//
// Returns { text, blocks, pageBreaks, artifacts, status }:
//   text       — the CANONICAL normalised string (utils/textNormalize). Every
//                downstream span (claims, hostility, UI highlights) indexes into
//                this exact string. Immutable once produced.
//   blocks     — [{ text, start, end, page, styleHints }] paragraph blocks with
//                offsets satisfying text.slice(start, end) === block.text.
//   pageBreaks — canonical offsets where a new page starts. Persisted (Resume)
//                so `blocks` can be rebuilt later via textNormalize.buildBlocks
//                without re-parsing the file — re-parsing would re-normalise and
//                silently invalidate every stored offset.
//   artifacts  — extraction-level hostility inputs consumed by
//                resumeDefenseService: invisibleChars, controlChars, and for
//                PDFs tinyFontChars / tinyFontSamples / textLayerChars (a text
//                layer far larger than its visibly-rendered share is a hidden
//                layer).
//   status     — success | empty | failed (unchanged contract).
//
// Backward compatible: existing callers destructure { text } and keep working.

const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const { normalizeText, buildBlocks } = require("./textNormalize");

// PDF font sizes below this many points are effectively invisible when printed
// or skimmed — a classic white-paper trick is 1pt keyword blocks.
const TINY_FONT_PT = 4;

// Custom pdf-parse page renderer: collects per-item font heights so hidden
// (tiny-font) text is measurable, and returns the page text ourselves so the
// per-page strings we normalise are exactly what went into the joined text.
function makePageRenderer(styleStats) {
  return async function render(pageData) {
    const content = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
    let pageText = "";
    let lastY = null;
    for (const item of content.items) {
      const str = item.str || "";
      // transform[3] is the vertical scale ≈ rendered font size in points.
      const fontPt = Math.abs((item.transform && item.transform[3]) || 0);
      styleStats.textLayerChars += str.length;
      if (str.trim() && fontPt > 0 && fontPt < TINY_FONT_PT) {
        styleStats.tinyFontChars += str.length;
        if (styleStats.tinyFontSamples.length < 5 && str.trim().length > 2) {
          styleStats.tinyFontSamples.push(str.trim().slice(0, 120));
        }
      }
      const y = item.transform ? item.transform[5] : null;
      if (lastY !== null && y !== null && Math.abs(y - lastY) > 1) pageText += "\n";
      pageText += str;
      if (item.hasEOL) pageText += "\n";
      if (y !== null) lastY = y;
    }
    return pageText;
  };
}

async function extractPdf(buffer) {
  const styleStats = { textLayerChars: 0, tinyFontChars: 0, tinyFontSamples: [] };
  const pageTexts = [];
  await pdfParse(buffer, {
    pagerender: async (pageData) => {
      const pageText = await makePageRenderer(styleStats)(pageData);
      pageTexts.push(pageText);
      return pageText;
    },
  });

  // Normalise each page independently, then join with a paragraph break. The
  // join IS the canonical text, so page-boundary offsets are exact by
  // construction rather than reverse-engineered.
  const normalizedPages = [];
  const artifacts = { invisibleChars: 0, controlChars: 0, ...styleStats, pageCount: pageTexts.length };
  for (const pageRaw of pageTexts) {
    const { text: pageText, artifacts: a } = normalizeText(pageRaw);
    artifacts.invisibleChars += a.invisibleChars;
    artifacts.controlChars += a.controlChars;
    normalizedPages.push(pageText);
  }

  const text = normalizedPages.join("\n\n").trim();
  const pageBreaks = [];
  let offset = 0;
  for (let i = 0; i < normalizedPages.length - 1; i += 1) {
    offset += normalizedPages[i].length + 2; // the "\n\n" separator
    pageBreaks.push(offset);
  }
  return { text, pageBreaks, artifacts };
}

async function extractResumeText(buffer, mimeType) {
  try {
    let text = "";
    let pageBreaks = [];
    let artifacts = { invisibleChars: 0, controlChars: 0 };

    if (mimeType === "application/pdf") {
      ({ text, pageBreaks, artifacts } = await extractPdf(buffer));
    } else {
      const result = await mammoth.extractRawText({ buffer });
      ({ text, artifacts } = normalizeText(result.value || ""));
    }

    const blocks = buildBlocks(text, pageBreaks);
    return { text, blocks, pageBreaks, artifacts, status: text.length > 0 ? "success" : "empty" };
  } catch (err) {
    console.error("Resume text extraction failed:", err.message);
    return { text: "", blocks: [], pageBreaks: [], artifacts: { invisibleChars: 0, controlChars: 0 }, status: "failed" };
  }
}

module.exports = extractResumeText;
module.exports.TINY_FONT_PT = TINY_FONT_PT;
