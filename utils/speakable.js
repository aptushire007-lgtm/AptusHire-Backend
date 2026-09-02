// Written form -> spoken form, for the interviewer's voice.
//
// Interview questions are AUTHORED to be read on a screen; they are then handed to a speech
// engine that reads them literally. "5+ years", "CI/CD", "K8s" and "e.g." are perfectly clear
// in print and unintelligible out loud — which is what a candidate reports as "the voice isn't
// clear". The voice is fine. The text was never meant to be spoken.
//
// WHY THIS DOES NOT WEAKEN THE AUDIT TRAIL. The authored text stays the record: it is what is
// stored on the turn, what a reviewer reads, and what speechAuthorization checks. This runs
// AFTER that check, purely as a rendering step between "the approved text" and "the sound
// waves" — exactly as a screen reader is not part of the document it reads. Because the mapping
// is a pure, deterministic function of the authored text, the spoken form is reproducible from
// what is already stored, so nothing extra needs persisting to reconstruct what a candidate
// heard.
//
// DESIGN RULE: never change meaning, only pronunciation. Every entry expands to something a
// human interviewer would actually say out loud for that token. If a mapping is ambiguous
// ("TS" -> TypeScript? Terraform State?) it does not belong here — the engine spelling out
// "T S" is a far smaller failure than the interviewer asking a different question.

// ---------------------------------------------------------------------------
// The term table
// ---------------------------------------------------------------------------

// `re` overrides the auto-built pattern for entries whose boundaries can't be derived from the
// key (leading punctuation, mainly). Longest key first is enforced below, so "ASP.NET" is
// consumed before ".NET" and "CI/CD" before the generic slash rule.
const TERMS = [
  // Container / infra shorthand
  { from: "K8s", to: "Kubernetes" },
  { from: "IaC", to: "infrastructure as code" },
  { from: "PoC", to: "proof of concept" },
  { from: "CI/CD", to: "C I, C D" },
  { from: "NoSQL", to: "No S Q L" },
  { from: "gRPC", to: "G R P C" },

  // Platforms whose written form has punctuation the engine reads aloud
  { from: "ASP.NET", to: "A S P dot NET" },
  { from: ".NET", to: "dot NET", re: /(^|[^A-Za-z0-9.])\.NET\b/g, replace: "$1dot NET" },
  { from: "C++", to: "C plus plus" },
  { from: "C#", to: "C sharp" },
  { from: "F#", to: "F sharp" },

  // Latin abbreviations — nobody says "e g" out loud
  { from: "e.g.", to: "for example" },
  { from: "i.e.", to: "that is" },
  { from: "etc.", to: "et cetera" },
  { from: "vs.", to: "versus" },
  { from: "vs", to: "versus" },

  // Symbols. These are padded with spaces in the replacement because the key carries no word
  // boundary of its own — without it "Q&A" renders as "QandA" and "50%" as "50percent". The
  // whitespace collapse at the end of toSpeakable tidies the doubled spaces this leaves behind.
  { from: "&", to: "and", replace: " and " },
  { from: "%", to: "percent", replace: " percent " },
  { from: "w/", to: "with", replace: " with " },
  { from: ">=", to: "at least", replace: " at least " },
  { from: "24/7", to: "twenty four seven" },

  // Units that are only ever abbreviated in writing
  { from: "yrs", to: "years" },
  { from: "yr", to: "year" },
];

// A key that starts/ends with an alphanumeric gets a word boundary on that side; one that starts
// or ends with punctuation must not (`\b` before "." matches in the wrong places).
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPattern(key) {
  const lead = /^[A-Za-z0-9]/.test(key) ? "\\b" : "";
  const tail = /[A-Za-z0-9]$/.test(key) ? "\\b" : "";
  return new RegExp(`${lead}${escapeRe(key)}${tail}`, "gi");
}

// Longest first so a key that contains another key wins (".NET" must not eat "ASP.NET").
const COMPILED = [...TERMS]
  .sort((a, b) => b.from.length - a.from.length)
  .map((t) => ({
    from: t.from,
    to: t.to,
    re: t.re || buildPattern(t.from),
    replace: t.replace !== undefined ? t.replace : t.to,
  }));

// ---------------------------------------------------------------------------
// Structural rules
// ---------------------------------------------------------------------------

// Applied after the table, so table entries like "24/7" are already gone.
const STRUCTURAL = [
  // "5+ years" -> "5 plus years". The engine otherwise reads the plus as silence.
  { name: "plus", re: /(\d)\s*\+/g, replace: "$1 plus" },
  // "3x" -> "3 times"
  { name: "times", re: /\b(\d+)\s*x\b/gi, replace: "$1 times" },
  // "3-5 years" -> "3 to 5 years". A hyphen between digits is read as a minus sign or swallowed.
  { name: "range", re: /\b(\d+)\s*-\s*(\d+)\b/g, replace: "$1 to $2" },
  // "REST/gRPC" -> "REST, gRPC" — a comma gives the pause a person would leave. Requires an
  // uppercase letter on one side so ordinary prose ("and/or", "he/she") is left alone.
  {
    name: "slash",
    re: /\b([A-Za-z][A-Za-z0-9.#+-]*)\/([A-Za-z][A-Za-z0-9.#+-]*)\b/g,
    replace: (match, a, b) => (/[A-Z]/.test(a) || /[A-Z]/.test(b) ? `${a}, ${b}` : match),
  },
  // "Node.js" -> "Node J S". Any Capitalised word followed by ".js".
  { name: "dotjs", re: /\b([A-Z][A-Za-z0-9]*)\.js\b/g, replace: "$1 J S" },
];

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Returns { text, changes }. `changes` names which rules fired — for logs and for a test to
// assert on, never for a scoring path.
function toSpeakable(input) {
  const original = String(input == null ? "" : input);
  let text = original;
  const changes = [];

  for (const entry of COMPILED) {
    entry.re.lastIndex = 0;
    if (!entry.re.test(text)) continue;
    entry.re.lastIndex = 0;
    text = text.replace(entry.re, entry.replace);
    changes.push(entry.from);
  }

  for (const rule of STRUCTURAL) {
    const next = text.replace(rule.re, rule.replace);
    if (next !== text) {
      changes.push(rule.name);
      text = next;
    }
  }

  // Collapse whitespace the substitutions may have doubled up. Punctuation is left alone —
  // it is what the engine uses for pacing.
  text = text.replace(/[ \t]+/g, " ").replace(/ +([,.;:!?])/g, "$1").trim();

  return { text, changes };
}

module.exports = { toSpeakable, TERMS, STRUCTURAL };
