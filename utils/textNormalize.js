// Canonical résumé-text normalisation (BUILD-PLAN Phase 4.1).
//
// The normalised string produced here is THE coordinate space for the whole
// evidence engine: every claim span, hostility span, and UI highlight is a
// (start, end) pair into this exact string. It is computed ONCE at ingest and
// then treated as immutable — never re-normalise downstream, or every stored
// offset silently goes stale.
//
// Rules (order matters; all deterministic):
//   1. Unicode NFKC (folds ligatures, fullwidth forms, NBSP → space, …)
//   2. Strip zero-width / bidi-control / soft-hyphen characters — these are
//      invisible when rendered, so they are BOTH a normalisation concern and a
//      hidden-text signal; we count them before removing.
//   3. \r\n and \r → \n
//   4. Other C0/C1 control chars (except \n and \t) → removed and counted
//   5. Tab → space; runs of spaces → one space; trailing line spaces stripped
//   6. 3+ consecutive newlines → exactly 2 (paragraph break preserved)
//   7. trim()

// Invisible-when-rendered characters. Their *count* is a hidden-text signal
// (a handful appear in honest documents via copy-paste; hundreds are a payload).
// U+200B–200F zero-width + directional marks · U+202A–202E bidi embeddings ·
// U+2060–2064 word joiners · U+FEFF BOM · U+00AD soft hyphen.
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;
// C0/C1 controls except \t (U+0009) and \n (U+000A); \r is handled separately first.
const CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

function normalizeText(raw) {
  const input = String(raw || "");
  const artifacts = { invisibleChars: 0, controlChars: 0 };

  let text = input.normalize("NFKC");

  text = text.replace(INVISIBLE_RE, () => {
    artifacts.invisibleChars += 1;
    return "";
  });

  text = text.replace(/\r\n?/g, "\n");

  text = text.replace(CONTROL_RE, () => {
    artifacts.controlChars += 1;
    return "";
  });

  text = text
    .replace(/\t/g, " ")
    .replace(/ {2,}/g, " ")
    .replace(/ +\n/g, "\n")
    .replace(/\n +/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text, artifacts };
}

// Paragraph blocks over the canonical text. Offsets satisfy
// text.slice(start, end) === block.text — pinned by tests, relied on by the UI.
// `pageBreaks` (optional): canonical-text offsets where a new page starts,
// produced by the PDF extractor; blocks after the Nth break get page N+1.
function buildBlocks(text, pageBreaks = []) {
  const blocks = [];
  let cursor = 0;
  for (const para of text.split("\n\n")) {
    const start = text.indexOf(para, cursor);
    const end = start + para.length;
    cursor = end;
    let page = null;
    if (pageBreaks.length > 0) {
      page = 1;
      for (const brk of pageBreaks) if (start >= brk) page += 1;
    }
    if (para.trim().length > 0) blocks.push({ text: para, start, end, page, styleHints: {} });
  }
  return blocks;
}

module.exports = { normalizeText, buildBlocks };
