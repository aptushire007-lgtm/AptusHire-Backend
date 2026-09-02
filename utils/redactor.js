// Bias-blinding redactor (BUILD-PLAN Phase 5.6).
//
// Removes protected-characteristic proxies from what the MODEL sees, BEFORE
// extraction — names, contact details, pronouns, gender/marital markers,
// graduation years (age proxy), and university *brands* (the qualification
// stays, the prestige signal goes). Redaction is expressed as exclusion spans
// over the canonical text and applied by promptSafety.buildModelView, which is
// OFFSET-PRESERVING: the view has the same length as the canonical text, so
// span arithmetic never diverges.
//
// The bias guarantee is structural: two résumés differing only in a redacted
// marker produce byte-identical model input (after whitespace collapse), so
// with temperature-0 extraction they produce identical claim sets. The Phase 1
// counterfactual probe proves it; a non-zero delta means a leak HERE.

const REDACTOR_VERSION = "2026-08-18.1";

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_RE = /(?:\+?\d{1,3}[-\s]?)?(?:\d[-\s]?){9,12}\d/g;
const URL_RE = /(?:https?:\/\/|www\.)[^\s|]+|(?:linkedin\.com|github\.com)\/[^\s|]+/gi;

// Pronouns and gendered courtesy titles. "her" the possessive and "her" the
// object are both proxies; both go.
// ALL third-person pronouns go, including they/them: singular they is itself a
// gender marker, and extraction needs no pronouns. This also keeps the
// counterfactual guarantee total — any pronoun swap collapses to the same view.
const PRONOUN_RE = /\b(?:he|him|his|she|her|hers|they|them|their|theirs|himself|herself|themselves)\b/gi;
// "Ms" is deliberately absent — it collides with "MS Excel"/"MS SQL"; "Mrs" and
// "Miss" cover the courtesy-title signal without that false positive.
const TITLE_RE = /\b(?:mr|mrs|miss|shri|smt)\.\s/gi;
// "single" is deliberately absent — "single page application" is résumé prose.
// Standalone marital words are rare enough to match; labelled fields match the
// whole line.
const MARKER_RE = /\b(?:male|female|married|divorced|widowed|unmarried)\b|marital\s+status\s*:[^\n]*|nationality\s*:[^\n]*|date\s+of\s+birth[^\n]*|\bdob\s*:[^\n]*/gi;

// Institution phrases: a run of capitalised words around an institution
// keyword. Keeps the degree line readable while removing the brand.
const INSTITUTION_RE =
  /(?:[A-Z][\w'&.-]*\s+){0,4}(?:University|College|Institute|Institution|Academy|Polytechnic|School|IIT|IIM|NIT|BITS)(?:\s+(?:of|for)\s+[A-Z][\w'&.-]*(?:\s+(?:(?:and|&)\s+)?[A-Z][\w'&.-]*){0,3})?(?:\s+[A-Z][\w'&.-]*){0,2}/g;

// A 4-digit year on a line that is clearly about education = graduation year
// (age proxy). Employment dates stay — the timeline checks need them.
const EDU_LINE_RE = /^.*\b(?:bachelor|master|b\.?\s?(?:a|sc|com|e|tech|ed)|m\.?\s?(?:a|sc|com|e|tech|ed)|mba|phd|diploma|degree|university|college|institute|school|education)\b.*$/gim;
const YEAR_RE = /\b(?:19|20)\d{2}\b/g;

function addMatches(spans, text, re, reason) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim().length === 0) continue;
    spans.push({ start: m.index, end: m.index + m[0].length, reason });
    if (m.index === re.lastIndex) re.lastIndex += 1;
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---- Name occurrences: ONE matcher, shared with the counterfactual probe ----
//
// The lookahead permits a following UPPERCASE letter. PDF text extraction glues
// adjacent style runs, so a bold name followed by a label arrives as
// "Govind Kumar JhaEmail:" — seen live 2026-08-18, where the glued surname
// slipped past a strict `(?![A-Za-z0-9])` boundary and reached the model. A
// case seam is therefore treated as a word boundary; a following LOWERCASE
// letter still blocks, so a name that happens to prefix an ordinary lowercase
// word ("Ram" in "ramp") is untouched. (An ALL-CAPS continuation — "RAM" in
// "RAMP" — does match now: for a candidate actually named Ram that costs a few
// blanked capitals, and under-redacting a name is the worse error.) The
// lookbehind stays strict: extraction glue puts the seam AFTER the name
// (value-then-Label), and relaxing the front would start matching the tails of
// ALL-CAPS skill words instead ("RAM" inside "PROGRAMMING").
//
// No `i` flag — deliberately. Under `i` the lookahead's `[a-z0-9]` also matches
// uppercase, which silently restores the strict boundary this exists to relax.
// Case-insensitivity for the token itself comes from expanding each letter into
// a two-case class instead.
//
// qaGateService.runCounterfactual swaps with THIS matcher (full-name variant)
// — a swapper with different boundary rules than the redactor reports its own
// asymmetry as a leak, which is how the 2026-08-18 incident was half false
// alarm. That is why nameSpans/replaceNameOccurrences live here, not in the
// gate.
function bothCases(token) {
  return token
    .split("")
    .map((ch) => {
      const lower = ch.toLowerCase();
      const upper = ch.toUpperCase();
      return lower === upper ? escapeRegex(ch) : `[${escapeRegex(upper)}${escapeRegex(lower)}]`;
    })
    .join("");
}

function nameTokenRegex(token) {
  return new RegExp(`(?<![A-Za-z0-9])${bothCases(token)}(?![a-z0-9])`, "g");
}

function nameVariants(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return [];
  // The full name plus each token separately (headers are often ALL-CAPS or
  // reordered); tokens under 3 chars skipped — too many false hits ("Md", "Al").
  return [...new Set([trimmed, ...trimmed.split(/\s+/).filter((t) => t.length >= 3)])];
}

/**
 * Every span the name pass redacts. Default: full name and each token, all
 * occurrences. `fullNameOnly` restricts to occurrences of the complete name —
 * the counterfactual probe's definition of "this is the candidate", see below.
 */
function nameSpans(text, name, { fullNameOnly = false } = {}) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return [];
  const variants = fullNameOnly ? [trimmed] : nameVariants(name);
  const spans = [];
  for (const token of variants) {
    addMatches(spans, text, nameTokenRegex(token), "name");
  }
  return spans;
}

/**
 * Rewrite every FULL-name occurrence (seam-aware, via the same matcher the
 * redaction pass uses) with `replacement`. For the counterfactual probe.
 *
 * Deliberately narrower than what planRedactions blanks: the probe swaps only
 * text that is unambiguously the candidate's name. A standalone token the
 * redactor blanks but the swap keeps ("May" in "May 2022" for a candidate named
 * May Chen) then survives into the swapped view and surfaces as a delta — which
 * is CORRECT, because for that candidate the redactor is eating non-name
 * content (her employment months) and a human should see that. Swapping every
 * token would rewrite the month too and hide the collision.
 */
function replaceNameOccurrences(text, name, replacement) {
  const spans = [...nameSpans(text, name, { fullNameOnly: true })].sort(
    (a, b) => a.start - b.start || b.end - a.end
  );
  let out = "";
  let cursor = 0;
  for (const s of spans) {
    if (s.start < cursor) {
      cursor = Math.max(cursor, s.end);
      continue;
    }
    out += text.slice(cursor, s.start) + replacement;
    cursor = s.end;
  }
  return out + text.slice(cursor);
}

/**
 * Compute redaction spans over the canonical text.
 * `known` may carry values we hold structurally: { name, email, phone }.
 * Returns [{ start, end, reason }] for promptSafety.buildModelView.
 */
function planRedactions(text, known = {}) {
  const spans = [];

  // Known values first: every occurrence, case-insensitive.
  if (known.name && known.name.trim()) {
    spans.push(...nameSpans(text, known.name));
  }
  for (const [value, reason] of [
    [known.email, "email"],
    [known.phone, "phone"],
  ]) {
    if (value && String(value).trim()) {
      addMatches(spans, text, new RegExp(escapeRegex(String(value).trim()), "gi"), reason);
    }
  }

  addMatches(spans, text, EMAIL_RE, "email");
  addMatches(spans, text, PHONE_RE, "phone");
  addMatches(spans, text, URL_RE, "url");
  addMatches(spans, text, PRONOUN_RE, "pronoun");
  addMatches(spans, text, TITLE_RE, "title");
  addMatches(spans, text, MARKER_RE, "marker");
  addMatches(spans, text, INSTITUTION_RE, "institution");

  // Graduation years: 4-digit years, but only on education lines.
  EDU_LINE_RE.lastIndex = 0;
  let line;
  while ((line = EDU_LINE_RE.exec(text)) !== null) {
    YEAR_RE.lastIndex = 0;
    let y;
    while ((y = YEAR_RE.exec(line[0])) !== null) {
      spans.push({ start: line.index + y.index, end: line.index + y.index + y[0].length, reason: "graduation_year" });
    }
    if (line.index === EDU_LINE_RE.lastIndex) EDU_LINE_RE.lastIndex += 1;
  }

  return spans;
}

module.exports = { planRedactions, nameSpans, replaceNameOccurrences, REDACTOR_VERSION };
