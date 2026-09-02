// Skill ontology (BUILD-PLAN Phase 5.4) — canonicalisation of skill vocabulary
// so "React.js" / "ReactJS" / "JSX" unify to one id and a vocabulary mismatch
// never causes a rejection. Pure code + data/skills.json; no model involved.
//
// Also consumed by resumeDefenseService (Phase 4): a keyword-stuffed résumé is
// one whose skill wall is full of ONTOLOGY-RECOGNISED technical skills that
// appear nowhere else in the document — a teacher's legitimate (non-technical)
// skills section never trips that test.

const fs = require("fs");
const path = require("path");

const ONTOLOGY_PATH = path.join(__dirname, "..", "data", "skills.json");

let cache = null;

function load() {
  if (cache) return cache;
  const raw = JSON.parse(fs.readFileSync(ONTOLOGY_PATH, "utf8"));
  const aliasToCanonical = new Map();
  for (const [canonical, entry] of Object.entries(raw.skills)) {
    aliasToCanonical.set(cleanTerm(canonical), canonical);
    for (const alias of entry.aliases || []) {
      aliasToCanonical.set(cleanTerm(alias), canonical);
    }
  }
  // Longest-first so multi-word aliases win over their substrings when scanning.
  const scanList = [...aliasToCanonical.keys()].sort((a, b) => b.length - a.length);
  cache = { version: raw.version, aliasToCanonical, scanList };
  return cache;
}

// Normalise a term for lookup: lowercase, collapse whitespace, strip fluff
// like version suffixes ("react 18" → handled via alias, "react v18.2" → "react").
function cleanTerm(term) {
  return String(term || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[()[\]{}"']/g, "")
    .replace(/\s*v?\d+(\.\d+)*\s*$/, "") // trailing version numbers
    .trim();
}

// Canonicalise one term. Returns the canonical id or null if unknown.
function canonicalizeSkill(term) {
  const { aliasToCanonical } = load();
  const cleaned = cleanTerm(term);
  if (!cleaned) return null;
  if (aliasToCanonical.has(cleaned)) return aliasToCanonical.get(cleaned);
  // Tolerate simple punctuation variants: "node-js" / "node_js" → "node js"
  const softened = cleaned.replace(/[-_/]/g, " ").replace(/\s+/g, " ").trim();
  if (aliasToCanonical.has(softened)) return aliasToCanonical.get(softened);
  return null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Find every canonical skill mentioned in free text (word-boundary matches of
// any alias). Returns Map canonical → occurrence count.
function findSkillsInText(text) {
  const { scanList, aliasToCanonical } = load();
  const lower = String(text || "").toLowerCase();
  const found = new Map();
  for (const alias of scanList) {
    if (alias.length < 2) continue;
    const re = new RegExp(`(?<![a-z0-9])${escapeRegex(alias)}(?![a-z0-9])`, "g");
    let m;
    while ((m = re.exec(lower)) !== null) {
      const canonical = aliasToCanonical.get(alias);
      found.set(canonical, (found.get(canonical) || 0) + 1);
      if (m.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return found;
}

// Canonicalise a list, dropping unknowns and de-duplicating. Unknown terms are
// returned separately so the ontology can grow from observed misses.
function canonicalizeList(terms) {
  const canonical = new Set();
  const unknown = [];
  for (const t of terms || []) {
    const c = canonicalizeSkill(t);
    if (c) canonical.add(c);
    else if (cleanTerm(t)) unknown.push(cleanTerm(t));
  }
  return { canonical: [...canonical], unknown };
}

function ontologyVersion() {
  return load().version;
}

module.exports = { canonicalizeSkill, canonicalizeList, findSkillsInText, cleanTerm, ontologyVersion };
