// Zero-dependency PDF generator.
//
// Produces a valid PDF 1.4 document using the two built-in (non-embedded) Helvetica fonts, so
// no font files are needed. Scope is deliberately small: flowing text with word-wrap +
// pagination, filled rectangles (score bars, chat bubbles, header band) and horizontal rules —
// exactly what the interview report needs. This matches the platform's zero-dep house style
// (see utils/logger.js, utils/metrics.js) and keeps a genuine downloadable .pdf without pulling
// in a heavyweight rendering library.
//
// Text is measured with the real Helvetica / Helvetica-Bold AFM advance-width tables (units per
// 1000 em) so wrapping is accurate. Content is encoded as WinAnsi (Latin-1); characters outside
// it are transliterated to their closest WinAnsi byte (see sanitize()).

// Helvetica advance widths for character codes 32..126 (index = code - 32).
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
// Helvetica-Bold advance widths for character codes 32..126.
const HELVB = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// Common Unicode → WinAnsi byte transliterations so pasted resume/transcript text (smart quotes,
// dashes, bullets) renders instead of dropping out.
const UNI_ARROWS = { "→": "->", "←": "<-", "⇒": "=>", "✓": "v", "✗": "x" };
const UNI = {
  "–": 0x96, "—": 0x97, "‘": 0x91, "’": 0x92,
  "“": 0x93, "”": 0x94, "•": 0x95, "…": 0x85,
  " ": 0x20, "‑": 0x2d, "‒": 0x2d, "‐": 0x2d,
};

// Map arbitrary text to a WinAnsi byte string. Anything with no representable byte becomes '?'.
function sanitize(input) {
  const s = String(input == null ? "" : input);
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 0x09) { out += " "; continue; }
    if (cp < 0x20 || cp === 0x7f) continue; // drop other control chars (incl. newlines — caller splits)
    if (cp <= 0xff) { out += String.fromCharCode(cp); continue; }
    if (UNI_ARROWS[ch] != null) { out += UNI_ARROWS[ch]; continue; }
    if (UNI[ch] != null) { out += String.fromCharCode(UNI[ch]); continue; }
    out += "?";
  }
  return out;
}

function widthOf(code, bold) {
  if (code >= 32 && code <= 126) return (bold ? HELVB : HELV)[code - 32];
  return bold ? 611 : 556; // reasonable fallback for high-Latin1 accented glyphs
}

// Width of an already-sanitized WinAnsi string at a given font size (points).
function measure(str, size, bold) {
  let w = 0;
  for (let i = 0; i < str.length; i++) w += widthOf(str.charCodeAt(i), bold);
  return (w / 1000) * size;
}

// Greedy word-wrap into lines no wider than maxWidth. A single word longer than maxWidth is
// hard-broken by character so it can never overflow the page.
function wrap(str, size, bold, maxWidth) {
  const words = sanitize(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  const pushWordBroken = (word) => {
    let cur = "";
    for (const c of word) {
      if (cur && measure(cur + c, size, bold) > maxWidth) {
        lines.push(cur);
        cur = c;
      } else {
        cur += c;
      }
    }
    return cur;
  };
  for (const word of words) {
    const candidate = line ? line + " " + word : word;
    if (measure(candidate, size, bold) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      if (measure(word, size, bold) > maxWidth) {
        line = pushWordBroken(word);
      } else {
        line = word;
      }
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function escapePdf(str) {
  return str.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function col(c) {
  // [r,g,b] in 0..1 → "r g b"
  return c.map((v) => Math.max(0, Math.min(1, v)).toFixed(3)).join(" ");
}

class PdfDoc {
  constructor(opts = {}) {
    this.pageWidth = opts.pageWidth || 612; // US Letter
    this.pageHeight = opts.pageHeight || 792;
    this.margin = opts.margin || 54;
    this.pages = [];
    this._newPage();
  }

  get left() { return this.margin; }
  get right() { return this.pageWidth - this.margin; }
  get contentWidth() { return this.pageWidth - 2 * this.margin; }

  _newPage() {
    this._buf = [];
    this.pages.push(this._buf);
    this.y = this.pageHeight - this.margin; // pen starts at top of content area
  }

  ensure(h) {
    if (this.y - h < this.margin) this._newPage();
  }

  moveDown(h) { this.y -= h; }

  // Absolute filled rectangle; (x, yTop) is the top-left corner in page space (y grows upward).
  _fill(x, yTop, w, h, color) {
    this._buf.push(`${col(color)} rg ${x.toFixed(2)} ${(yTop - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }

  // Draw one already-wrapped line at an absolute baseline.
  _line(x, baseline, str, size, bold, color, align = "left", boxWidth = 0) {
    let tx = x;
    if (align !== "left" && boxWidth > 0) {
      const w = measure(str, size, bold);
      if (align === "center") tx = x + (boxWidth - w) / 2;
      else if (align === "right") tx = x + (boxWidth - w);
    }
    const font = bold ? "/F2" : "/F1";
    this._buf.push(
      `${col(color)} rg BT ${font} ${size} Tf 1 0 0 1 ${tx.toFixed(2)} ${baseline.toFixed(2)} Tm (${escapePdf(str)}) Tj ET`
    );
  }

  // Flow a block of text (word-wrapped + paginated). Advances the pen. Returns bottom y.
  text(str, opts = {}) {
    const size = opts.size || 11;
    const bold = !!opts.bold;
    const color = opts.color || [0.1, 0.12, 0.16];
    const lineGap = opts.lineGap != null ? opts.lineGap : 5;
    const indent = opts.indent || 0;
    const align = opts.align || "left";
    const x = this.left + indent;
    const boxWidth = (opts.width || this.contentWidth) - indent;
    const lh = size * 1.2 + lineGap;
    const lines = wrap(str, size, bold, boxWidth);
    for (const ln of lines) {
      this.ensure(lh);
      this._line(x, this.y - size, ln, size, bold, color, align, boxWidth);
      this.y -= lh;
    }
    if (opts.gap) this.y -= opts.gap;
    return this.y;
  }

  // Full-width horizontal rule.
  hr(opts = {}) {
    const color = opts.color || [0.9, 0.91, 0.93];
    this.ensure(opts.gap || 10);
    this.y -= (opts.gapBefore != null ? opts.gapBefore : 4);
    this._fill(this.left, this.y, this.contentWidth, opts.weight || 1, color);
    this.y -= (opts.gapAfter != null ? opts.gapAfter : 8);
  }

  // A labelled 0..100 score bar (track + proportional fill + numeric value).
  scoreBar(label, value, opts = {}) {
    const size = 10;
    const barH = 7;
    const rowH = size * 1.2 + barH + 12;
    this.ensure(rowH);
    const v = value == null ? null : Math.max(0, Math.min(100, Number(value)));
    // label row
    this._line(this.left, this.y - size, sanitize(label), size, false, [0.42, 0.45, 0.5]);
    const valText = v == null ? "—" : `${Math.round(v)}/100`;
    this._line(this.left, this.y - size, valText, size, true, [0.1, 0.12, 0.16], "right", this.contentWidth);
    this.y -= size * 1.2 + 4;
    // track
    this._fill(this.left, this.y, this.contentWidth, barH, [0.9, 0.91, 0.93]);
    if (v != null && v > 0) {
      const c = v >= 75 ? [0.13, 0.7, 0.46] : v >= 55 ? [0.96, 0.62, 0.07] : [0.86, 0.15, 0.15];
      this._fill(this.left, this.y, (this.contentWidth * v) / 100, barH, c);
    }
    this.y -= barH + 12;
  }

  // A chat bubble for the transcript. role "ai" left/grey, else right/brand. Wraps + paginates.
  // opts.meta (candidate turns only) prints an extra caption line — e.g. word count /
  // duration / responsive tag — below the answer-score line.
  bubble(role, str, score, opts = {}) {
    const isAi = role === "ai";
    const size = 10;
    const pad = 8;
    const bubbleWidth = this.contentWidth * 0.82;
    const textWidth = bubbleWidth - 2 * pad;
    const lines = wrap(str, size, false, textWidth);
    const lh = size * 1.2 + 3;
    const scoreLine = !isAi && score != null;
    const metaLine = !isAi && !!opts.meta;
    const extraLines = (scoreLine ? 1 : 0) + (metaLine ? 1 : 0);
    const boxH = pad * 2 + lines.length * lh + extraLines * lh;
    // keep small bubbles from splitting awkwardly; only force a page when it can't fit at all
    this.ensure(Math.min(boxH, this.pageHeight - 2 * this.margin));
    const bx = isAi ? this.left : this.right - bubbleWidth;
    const top = this.y;
    this._fill(bx, top, bubbleWidth, boxH, isAi ? [0.96, 0.97, 0.98] : [0.16, 0.23, 0.42]);
    const textColor = isAi ? [0.28, 0.32, 0.38] : [1, 1, 1];
    let baseline = top - pad - size;
    for (const ln of lines) {
      this._line(bx + pad, baseline, ln, size, false, textColor, "left");
      baseline -= lh;
    }
    if (scoreLine) {
      this._line(bx + pad, baseline, `Answer score: ${Math.round(score)}/100`, size - 1, true, [0.72, 0.8, 1], "left");
      baseline -= lh;
    }
    if (metaLine) {
      this._line(bx + pad, baseline, opts.meta, size - 1, false, [0.72, 0.8, 1], "left");
    }
    this.y = top - boxH - 8;
  }

  // Serialize to a Buffer containing the complete PDF file.
  render() {
    const objects = []; // objects[i] is the body for object number i+1
    const add = (body) => { objects.push(body); return objects.length; };

    // Reserve fixed object numbers: 1=Catalog, 2=Pages, 3=F1, 4=F2.
    add(""); // 1 catalog (filled later)
    add(""); // 2 pages (filled later)
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

    const pageObjNums = [];
    for (const buf of this.pages) {
      const stream = buf.join("\n");
      const len = Buffer.byteLength(stream, "latin1");
      const contentNum = add(`<< /Length ${len} >>\nstream\n${stream}\nendstream`);
      const pageNum = add(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.pageWidth} ${this.pageHeight}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentNum} 0 R >>`
      );
      pageObjNums.push(pageNum);
    }

    objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[1] =
      `<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageObjNums.length} >>`;

    // Assemble file, tracking byte offsets for the xref table.
    let pdf = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"; // binary comment marks it as binary
    const offsets = [];
    for (let i = 0; i < objects.length; i++) {
      offsets[i] = Buffer.byteLength(pdf, "latin1");
      pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }
    const xrefOffset = Buffer.byteLength(pdf, "latin1");
    const count = objects.length + 1;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let i = 0; i < objects.length; i++) {
      xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }
    const trailer = `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
    pdf += xref + trailer;
    return Buffer.from(pdf, "latin1");
  }
}

module.exports = { PdfDoc, sanitize };
