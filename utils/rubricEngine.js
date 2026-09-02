// Pure rubric-compilation logic (BUILD-PLAN Phase 3). No I/O, no DB, no LLM —
// everything here is deterministic and unit-testable, mirroring atsEngine.
//
// Division of labour (engineering rule 1): the LLM proposes criteria and RELATIVE
// importance; the arithmetic — weight normalisation, thresholds, flag validation —
// happens here, in code. The model never emits a number that becomes a score.

const crypto = require("crypto");

// `disqualifier` stays in this list because rubrics FROZEN before importance
// tiers landed contain them, and a frozen rubric must keep scoring exactly as it
// did the day it was approved (evidenceScorer still honours the gate). Nothing
// authors one any more — see AUTHORABLE_KINDS.
const CRITERION_KINDS = ["must_have", "nice_to_have", "disqualifier"];
const AUTHORABLE_KINDS = ["must_have", "nice_to_have"];
const EVIDENCE_TYPES = ["skill", "experience", "education", "project", "certification", "outcome"];
const MAX_CRITERIA = 20;

// ---- Importance tiers --------------------------------------------------------
// The one weight control anybody touches — a recruiter picks a WORD and code
// turns the word into the number. This is engineering rule 1 applied to the
// human as well as the model: nobody types a weight, so no rubric can carry a
// number nobody can defend. Ask "why is this 35%?" of a typed slider and there
// is no answer; ask it here and the answer is "it is Critical, and Critical
// means 8× a Bonus in every rubric this tenant has ever approved".
//
// The multipliers are a geometric ladder (8/4/2/1), so a tier's meaning RELATIVE
// to the others is constant no matter how many criteria the rubric ends up with.
// `kind` is derived, not chosen: the must-have / nice-to-have distinction the
// evidence matcher needs falls out of the tier instead of being a second
// question the recruiter has to answer.
const IMPORTANCE_TIERS = [
  {
    key: "critical",
    label: "Critical",
    multiplier: 8,
    kind: "must_have",
    blurb: "Weak here and the candidate is not hireable for this role.",
  },
  {
    key: "important",
    label: "Important",
    multiplier: 4,
    kind: "must_have",
    blurb: "Expected of the role. Counts heavily, but one gap is survivable.",
  },
  {
    key: "helpful",
    label: "Helpful",
    multiplier: 2,
    kind: "nice_to_have",
    blurb: "Genuinely useful; someone without it can still advance.",
  },
  {
    key: "bonus",
    label: "Bonus",
    multiplier: 1,
    kind: "nice_to_have",
    blurb: "A tiebreaker. Barely moves the score on its own.",
  },
];

const IMPORTANCE_KEYS = IMPORTANCE_TIERS.map((t) => t.key);
const DEFAULT_IMPORTANCE = "important";

function tierFor(key) {
  return IMPORTANCE_TIERS.find((t) => t.key === key) || null;
}

/**
 * The tier word to SHOW for a criterion. Criteria compiled before tiers existed
 * carry no `importance`, so fall back to the kind they were authored with rather
 * than inventing a precision the original author never expressed. Legacy
 * disqualifiers return null — they are gates, not rungs on this ladder.
 */
function importanceOf(criterion) {
  if (criterion?.importance && tierFor(criterion.importance)) return criterion.importance;
  if (criterion?.kind === "must_have") return "critical";
  if (criterion?.kind === "nice_to_have") return "helpful";
  return null;
}

/**
 * Stamp `kind` and the RELATIVE weight onto a criterion from its tier word.
 * Mutates and returns it. The relative weight is the tier multiplier;
 * normaliseWeights turns the set of multipliers into fractions summing to 1.
 */
function applyImportance(criterion) {
  const tier = tierFor(criterion?.importance);
  if (!tier) return criterion; // legacy gate — left exactly as it was authored
  criterion.kind = tier.kind;
  criterion.weight = tier.multiplier;
  return criterion;
}

// Back-compat only: map a pre-tier proposal (kind + 0-100 relativeImportance)
// onto the ladder, so recorded LLM fixtures and any in-flight draft still land
// somewhere honest instead of being dropped.
function tierFromLegacyProposal(kind, relativeImportance) {
  const n = Number(relativeImportance);
  const score = Number.isFinite(n) ? n : 0;
  if (kind === "nice_to_have") return score >= 50 ? "helpful" : "bonus";
  return score >= 70 ? "critical" : "important";
}

// ---- Source text + hash ------------------------------------------------------

// One canonical serialisation of the JD-bearing fields. The rubric's sourceHash
// is sha256 of this string; a JD edit that changes it triggers supersede().
// Line endings are normalised so the hash is stable across OS and editors.
function buildSourceText(job) {
  const parts = [
    `title: ${job.title || ""}`,
    `description: ${job.description || ""}`,
    `requirements: ${job.requirements || ""}`,
    `requiredSkills: ${(job.requiredSkills || []).join(", ")}`,
    `minExperienceYears: ${job.minExperienceYears ?? 0}`,
    `requiredEducation: ${job.requiredEducation || ""}`,
  ];
  return parts.join("\n").replace(/\r\n?/g, "\n");
}

function sourceHashOf(job) {
  return crypto.createHash("sha256").update(buildSourceText(job)).digest("hex");
}

// ---- Weight normalisation (code arithmetic, engineering rule 1) --------------

/**
 * Normalise criterion weights IN CODE so scoreable weights always sum to exactly
 * 1.0. Disqualifiers are boolean gates, never weighted contributors — their
 * weight is forced to 0. Negative/missing proposed weights clamp to 0; if every
 * scoreable weight is 0 the mass is split equally (no criterion silently
 * dominates). Mutates and returns the array.
 */
function normaliseWeights(criteria) {
  const list = Array.isArray(criteria) ? criteria : [];
  const scoreable = [];
  for (const c of list) {
    if (c.kind === "disqualifier") {
      c.weight = 0;
    } else {
      c.weight = Math.max(0, Number(c.weight) || 0);
      scoreable.push(c);
    }
  }
  if (!scoreable.length) return list;

  const total = scoreable.reduce((s, c) => s + c.weight, 0);
  if (total === 0) {
    for (const c of scoreable) c.weight = 1 / scoreable.length;
  } else {
    for (const c of scoreable) c.weight = c.weight / total;
  }
  // Float sums drift a few ulps from 1.0 — pin the residue on the largest weight
  // so the invariant "weights sum to exactly 1" holds byte-for-byte.
  const sum = scoreable.reduce((s, c) => s + c.weight, 0);
  const largest = scoreable.reduce((a, b) => (b.weight > a.weight ? b : a));
  largest.weight += 1 - sum;
  return list;
}

// ---- JD quality detectors (Phase 3.3) ----------------------------------------
// Deterministic, code-only, each with the verbatim `evidence` snippet that fired
// it. These run on EVERY compile (AI and fallback) — the recruiter always gets
// told when the JD itself is the problem.

// Conservative first-release years for common technologies. Used to catch
// "N+ years of X" where N exceeds X's age — a requirement nobody can meet.
const TECH_BIRTH_YEARS = {
  react: 2013,
  "next.js": 2016,
  nextjs: 2016,
  vue: 2014,
  angular: 2016, // modern Angular (2+)
  svelte: 2016,
  typescript: 2012,
  "node.js": 2009,
  nodejs: 2009,
  deno: 2018,
  bun: 2022,
  docker: 2013,
  kubernetes: 2014,
  terraform: 2014,
  golang: 2012, // Go 1.0 ("go" alone is too ambiguous to match)
  rust: 2015, // Rust 1.0
  swift: 2014,
  kotlin: 2016, // Kotlin 1.0
  flutter: 2017,
  graphql: 2015,
  fastapi: 2018,
  tailwind: 2017,
  vite: 2020,
  mongodb: 2009,
  redis: 2009,
};

const PROXY_DETECTORS = [
  {
    code: "ELITE_PROXY",
    severity: "warning",
    pattern:
      /\bivy[- ]league\b|\btop[- ]?tier (?:universit(?:y|ies)|colleges?|schools?)\b|\btier[- ]?1 (?:colleges?|institutes?|universit(?:y|ies))\b|\bpremier institut(?:e|es|ions?)\b|\b(?:iits?|iims?|nits?|bits)\b[^.\n]{0,40}\b(?:only|prefer(?:red)?|alumni|graduates?)\b|\b(?:only|prefer(?:red)?(?: from)?)\b[^.\n]{0,40}\b(?:iits?|iims?|nits?|bits)\b/i,
    message:
      "Elite-university preference is a proxy that correlates with socioeconomic background, not job performance, and is hard to defend in a bias audit. Score what candidates can do, not where they studied.",
  },
  {
    code: "NATIVE_SPEAKER",
    severity: "warning",
    pattern: /\bnative(?:-level)?\s+(?:english\s+)?speakers?\b|\bnative fluency\b|\bmother tongue\b/i,
    message:
      '"Native speaker" excludes fluent non-native candidates and can amount to national-origin discrimination. Specify the actual proficiency needed (e.g. "professional working proficiency in English").',
  },
  {
    code: "DIGITAL_NATIVE",
    severity: "warning",
    pattern: /\bdigital[- ]natives?\b/i,
    message: '"Digital native" is a recognised age proxy. Name the concrete tool or skill you need instead.',
  },
  {
    code: "CONTINUOUS_EMPLOYMENT",
    severity: "warning",
    pattern:
      /\bno (?:employment |career |work )?gaps?\b|\bcontinuous(?:ly)? employ(?:ed|ment)\b|\bunbroken (?:career|employment|work history)\b|\bwithout (?:career |employment )?breaks?\b/i,
    message:
      "Demanding an unbroken employment history penalises caregiving, illness, and layoffs — correlated with sex and disability. Evaluate skills currency instead of calendar continuity.",
  },
  {
    code: "UNQUANTIFIABLE_HYPE",
    severity: "info",
    pattern: /\brock[- ]?star\b|\bninja\b|\bguru\b|\bwizard\b|\b10x (?:developer|engineer)\b|\bworld[- ]class\b|\bsuperstar\b/i,
    message: "Hype adjectives can't be evidenced or tested. Replace with a measurable requirement so candidates can be compared on it.",
  },
];

/**
 * Run every deterministic JD-quality detector over the canonical source text.
 * `criteria` (optional) enables structural checks like must-have overload;
 * `nowYear` is injectable so tests are clock-independent.
 * Returns [{ code, message, severity, evidence }].
 */
function detectQualityFlags(sourceText, { criteria, nowYear } = {}) {
  const text = String(sourceText || "");
  const year = nowYear || new Date().getFullYear();
  const flags = [];

  for (const d of PROXY_DETECTORS) {
    const m = text.match(d.pattern);
    if (m) flags.push({ code: d.code, message: d.message, severity: d.severity, evidence: m[0] });
  }

  // Years-of-experience demanded vs the technology's actual age.
  for (const [tech, born] of Object.entries(TECH_BIRTH_YEARS)) {
    const age = year - born;
    const escaped = tech.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const forward = new RegExp(`(\\d{1,2})\\s*\\+?\\s*(?:years?|yrs?)[^.\\n]{0,60}?\\b${escaped}\\b`, "i");
    const backward = new RegExp(`\\b${escaped}\\b[^.\\n]{0,60}?(\\d{1,2})\\s*\\+?\\s*(?:years?|yrs?)`, "i");
    const m = text.match(forward) || text.match(backward);
    if (m && Number(m[1]) > age) {
      flags.push({
        code: "YEARS_EXCEED_TECH_AGE",
        severity: "critical",
        evidence: m[0],
        message: `The JD asks for ${m[1]} years of ${tech}, but ${tech} is only about ${age} years old — nobody can meet this. Lower the number or drop it.`,
      });
    }
  }

  if (Array.isArray(criteria)) {
    const mustHaves = criteria.filter((c) => c.kind === "must_have").length;
    if (mustHaves > 10) {
      flags.push({
        code: "MUST_HAVE_OVERLOAD",
        severity: "warning",
        evidence: `${mustHaves} must-have criteria`,
        message: `${mustHaves} must-haves means almost nobody qualifies and every candidate fails something. Demote the negotiable ones to nice-to-have.`,
      });
    }
  }

  return flags;
}

// ---- Cite-or-drop for model-proposed flags (engineering rule 2) --------------

// Codes the model may propose on top of the deterministic detectors — things a
// regex can't see (vague requirements, contradictions). Anything else is dropped.
const MODEL_FLAG_CODES = new Set(["UNQUANTIFIABLE_REQUIREMENT", "AMBIGUOUS_REQUIREMENT", "CONTRADICTORY_REQUIREMENTS", "PROXY_REQUIREMENT"]);

/**
 * A model-proposed quality flag survives ONLY if its code is on the allow-list
 * and its `evidence` is a verbatim substring of the JD source text. A flag that
 * cannot be cited is dropped, not trusted — hallucinated JD problems must never
 * reach a recruiter. Returns { accepted, dropped }.
 */
function verifyModelFlags(modelFlags, sourceText) {
  const text = String(sourceText || "");
  const accepted = [];
  const dropped = [];
  for (const f of Array.isArray(modelFlags) ? modelFlags : []) {
    const ok =
      f &&
      MODEL_FLAG_CODES.has(f.code) &&
      typeof f.message === "string" &&
      f.message.trim() &&
      typeof f.evidence === "string" &&
      f.evidence.length >= 3 &&
      text.includes(f.evidence);
    if (ok) {
      accepted.push({ code: f.code, message: f.message.trim(), severity: "warning", evidence: f.evidence });
    } else {
      dropped.push(f);
    }
  }
  return { accepted, dropped };
}

// ---- AI-output sanitisation --------------------------------------------------

/**
 * Turn raw model criteria into schema-safe criteria. Invalid entries are DROPPED
 * (never repaired into something the model didn't say): missing label/rationale,
 * unrecognisable importance. Evidence types are filtered to the known enum. Ids
 * are assigned here (c1..cN).
 *
 * The model now proposes a tier WORD, never a number — code owns the arithmetic
 * end to end (engineering rule 1). A pre-tier proposal (kind + relativeImportance)
 * is mapped onto the ladder so recorded fixtures keep working; a proposal that
 * fits neither shape is dropped.
 */
function sanitiseAiCriteria(rawCriteria) {
  const out = [];
  for (const raw of (Array.isArray(rawCriteria) ? rawCriteria : []).slice(0, MAX_CRITERIA)) {
    if (!raw || typeof raw !== "object") continue;
    const label = typeof raw.label === "string" ? raw.label.trim() : "";
    const rationale = typeof raw.rationale === "string" ? raw.rationale.trim() : "";
    if (!label || !rationale) continue;

    let importance = IMPORTANCE_KEYS.includes(raw.importance) ? raw.importance : null;
    if (!importance) {
      // Legacy shape. Knock-out gates are no longer authored at all, so a
      // proposed disqualifier is dropped rather than silently reweighted into a
      // scoreable criterion it was never meant to be.
      if (!AUTHORABLE_KINDS.includes(raw.kind)) continue;
      importance = tierFromLegacyProposal(raw.kind, raw.relativeImportance);
    }

    const evidenceTypes = (Array.isArray(raw.evidenceTypes) ? raw.evidenceTypes : []).filter((t) => EVIDENCE_TYPES.includes(t));
    out.push(
      applyImportance({
        id: `c${out.length + 1}`,
        label,
        importance,
        kind: null, // derived from the tier below
        weight: 0, // derived from the tier below
        rationale,
        evidenceTypes: evidenceTypes.length ? evidenceTypes : ["experience"],
        acceptableEvidence: (Array.isArray(raw.acceptableEvidence) ? raw.acceptableEvidence : [])
          .filter((s) => typeof s === "string" && s.trim())
          .map((s) => s.trim()),
        probeHint: typeof raw.probeHint === "string" ? raw.probeHint.trim() : "",
        seniorityFloor: typeof raw.seniorityFloor === "string" ? raw.seniorityFloor.trim() : "",
      })
    );
  }
  return normaliseWeights(out);
}

// ---- Deterministic fallback compiler (Phase 3 guardrail) ---------------------

/**
 * Draft a rubric from the Job's STRUCTURED fields only — no free-text parsing,
 * no invention. Used when the LLM is unavailable (no key, breaker open, bad
 * output) and by the backfill script. Always labelled engine "fallback" by the
 * service; the flags below make the degradation visible on the artifact itself
 * (engineering rule 5: never render a placeholder as a measurement).
 */
function deterministicDraft(job) {
  const criteria = [];
  const flags = [];

  for (const skill of job.requiredSkills || []) {
    const s = String(skill).trim();
    if (!s) continue;
    criteria.push(
      applyImportance({
        id: `c${criteria.length + 1}`,
        label: `Working proficiency in ${s}`,
        importance: "important",
        rationale: `"${s}" is listed as a required skill on the job posting.`,
        evidenceTypes: ["skill", "experience", "project"],
        acceptableEvidence: [`Hands-on work experience using ${s}`, `A project or deliverable built with ${s}`],
        probeHint: `Ask for a specific task the candidate completed with ${s}, then probe one detail only hands-on use would teach.`,
        seniorityFloor: "",
      })
    );
  }

  if (Number(job.minExperienceYears) > 0) {
    criteria.push(
      applyImportance({
        id: `c${criteria.length + 1}`,
        label: `At least ${job.minExperienceYears} year(s) of relevant professional experience`,
        importance: "critical",
        rationale: `The posting sets a minimum of ${job.minExperienceYears} year(s) of experience.`,
        evidenceTypes: ["experience"],
        acceptableEvidence: ["Employment history in a relevant role covering the required duration"],
        probeHint: "Ask the candidate to walk through the scope and ownership of their most recent relevant role.",
        seniorityFloor: "",
      })
    );
  }

  if (job.requiredEducation && String(job.requiredEducation).trim()) {
    const edu = String(job.requiredEducation).trim();
    criteria.push(
      applyImportance({
        id: `c${criteria.length + 1}`,
        label: `Education: ${edu}`,
        importance: "helpful",
        rationale: `The posting lists "${edu}" as required education.`,
        evidenceTypes: ["education"],
        acceptableEvidence: [edu],
        probeHint: "",
        seniorityFloor: "",
      })
    );
    flags.push({
      code: "EDUCATION_REQUIREMENT",
      severity: "info",
      evidence: edu,
      message:
        "Degree requirements screen out experienced candidates and can have disparate impact. Consider whether equivalent practical experience should satisfy this criterion.",
    });
  }

  if (!criteria.length) {
    flags.push({
      code: "NO_STRUCTURED_FIELDS",
      severity: "critical",
      evidence: "requiredSkills/minExperienceYears/requiredEducation all empty",
      message:
        "This job has no structured requirements, so the deterministic compiler cannot draft criteria. Add required skills to the job, or compile with the AI engine.",
    });
  }

  flags.push({
    code: "FALLBACK_COMPILE",
    severity: "info",
    evidence: "compiled without AI",
    message:
      "Drafted from the job's structured fields only — the free-text description and requirements were NOT decomposed. Review carefully and edit before approving.",
  });

  return { criteria: normaliseWeights(criteria), qualityFlags: flags };
}

// ---- Thresholds --------------------------------------------------------------

// Two thresholds, not one (see Phase 6): ≥ advance ⇒ advance, < review ⇒ decline
// (subject to human-in-the-loop rules), between them ⇒ route to human review.
// Derived in code from the job's existing ATS threshold; recruiters can adjust
// on the draft before freezing.
function defaultThresholds(job) {
  const advance = Number.isFinite(Number(job.atsThreshold)) ? Number(job.atsThreshold) : 60;
  return { advance, review: Math.max(0, advance - 15) };
}

// Named cut-off settings, so "how selective is this role" is also a word rather
// than two numbers a recruiter has to invent and then justify. Custom numbers
// stay available for anyone who genuinely needs them — the preset is the default
// path, not a cage. Every preset keeps a review BAND (advance − review = 15):
// the whole point of two thresholds is that ambiguity reaches a person.
const THRESHOLD_PRESETS = [
  { key: "wide", label: "Wide net", advance: 50, review: 35, blurb: "Interview generously; let the interview do the filtering." },
  { key: "balanced", label: "Balanced", advance: 60, review: 45, blurb: "The default. Clear passes advance, clear misses decline." },
  { key: "selective", label: "Selective", advance: 70, review: 55, blurb: "Only strong evidence advances without a human read." },
  { key: "very_selective", label: "Very selective", advance: 80, review: 65, blurb: "Senior or scarce roles where a weak hire costs more than a slow one." },
];

/** Which preset a threshold pair corresponds to, or "custom" if it matches none. */
function thresholdPresetKey(thresholds) {
  const advance = Number(thresholds?.advance);
  const review = Number(thresholds?.review);
  const hit = THRESHOLD_PRESETS.find((p) => p.advance === advance && p.review === review);
  return hit ? hit.key : "custom";
}

module.exports = {
  CRITERION_KINDS,
  AUTHORABLE_KINDS,
  EVIDENCE_TYPES,
  MAX_CRITERIA,
  TECH_BIRTH_YEARS,
  IMPORTANCE_TIERS,
  IMPORTANCE_KEYS,
  DEFAULT_IMPORTANCE,
  THRESHOLD_PRESETS,
  tierFor,
  importanceOf,
  applyImportance,
  tierFromLegacyProposal,
  thresholdPresetKey,
  buildSourceText,
  sourceHashOf,
  normaliseWeights,
  detectQualityFlags,
  verifyModelFlags,
  sanitiseAiCriteria,
  deterministicDraft,
  defaultThresholds,
};
