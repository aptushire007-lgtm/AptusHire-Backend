// Span verification (BUILD-PLAN Phase 5.3) — the hallucination kill switch.
//
// The model emits QUOTES (strings), never offsets — offset arithmetic is
// code's job (engineering rule 1). For every quote this module:
//   1. locates it in the MODEL VIEW (the blanked/redacted same-length string
//      the model actually saw) using whitespace-tolerant matching — the model
//      receives whitespace-collapsed text, so its quotes may differ from the
//      canonical text only in whitespace;
//   2. converts the match to canonical (start, end) offsets and re-slices the
//      CANONICAL text for the stored quote, so the persisted span satisfies
//      resumeText.slice(start, end) === quote EXACTLY;
//   3. drops what does not locate. Dropped claims/spans are counted — the drop
//      rate is a first-class quality metric, and a rising rate is an alert.
//
// Because matching runs against the view, content that was neutralised or
// redacted (blanked to spaces) is STRUCTURALLY unquotable: a fabricated quote
// and a quote of excluded content fail identically — they are not in the view.

const MIN_QUOTE_LEN = 2;
const MAX_CLAIMS = 200; // guardrail: a stuffed document must not explode the graph

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Whitespace-tolerant, otherwise-verbatim regex for a model quote. Word-edge
// guards where the quote starts/ends alphanumerically, so a short quote like
// "Go" can never match inside "Google".
function quotePattern(quote) {
  const trimmed = String(quote).trim();
  const parts = trimmed.split(/\s+/).map(escapeRegex);
  if (parts.length === 0 || parts[0] === "") return null;
  const prefix = /^[A-Za-z0-9]/.test(trimmed) ? "(?<![A-Za-z0-9])" : "";
  const suffix = /[A-Za-z0-9]$/.test(trimmed) ? "(?![A-Za-z0-9])" : "";
  return new RegExp(prefix + parts.join("[\\s]+") + suffix);
}

/**
 * Locate one quote in the view. Returns { start, end } in canonical/view
 * coordinates (identical by construction) or null.
 */
function locateQuote(view, quote) {
  if (!quote || String(quote).trim().length < MIN_QUOTE_LEN) return null;
  const re = quotePattern(quote);
  if (!re) return null;
  const m = re.exec(view);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length };
}

/**
 * Verify a batch of raw model claims against (canonicalText, view).
 * Returns { claims, droppedClaims, droppedSpans } where every surviving claim
 * has ≥ 1 exact span into canonicalText.
 */
function verifyClaims(rawClaims, canonicalText, view) {
  if (view.length !== canonicalText.length) {
    throw new Error("spanVerifier: view and canonical text must be the same length (offset preservation broken)");
  }

  const claims = [];
  let droppedClaims = 0;
  let droppedSpans = 0;

  for (const raw of (rawClaims || []).slice(0, MAX_CLAIMS)) {
    const quotes = Array.isArray(raw.quotes) ? raw.quotes : [];
    const spans = [];
    for (const q of quotes.slice(0, 3)) {
      const loc = locateQuote(view, q);
      if (!loc) {
        droppedSpans += 1;
        continue;
      }
      const quote = canonicalText.slice(loc.start, loc.end);
      // Exactness pin: the stored quote IS the canonical slice.
      spans.push({ start: loc.start, end: loc.end, quote });
    }
    if (spans.length === 0) {
      droppedClaims += 1;
      continue;
    }
    claims.push({ ...raw, spans });
  }

  return { claims, droppedClaims, droppedSpans, truncated: (rawClaims || []).length > MAX_CLAIMS };
}

module.exports = { verifyClaims, locateQuote, MIN_QUOTE_LEN, MAX_CLAIMS };
