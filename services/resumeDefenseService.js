// Hostile-input defence for résumés (BUILD-PLAN Phase 4.2).
//
// Every résumé is treated as an adversarial document. This service runs a set
// of DETERMINISTIC detectors over the canonical text (+ extraction artifacts)
// and returns a structured hostility report:
//
//   {
//     version, analyzedAt, engine,
//     signals: [{ code, severity, message, spans: [{start,end,quote,page}], meta }],
//     excludedFromModel: [{ start, end, quote, codes }],   // fed to buildModelView
//     clean: Boolean
//   }
//
// Severities: "critical" (active manipulation attempt) · "warning" (score
// integrity concern) · "advisory" (context only — NEVER affects anything).
//
// Hard rules (CLAUDE.md engineering rule 7, and the Phase 4 guardrails):
//   - Detection NEVER auto-rejects and never changes a score. It reports.
//   - Suspicious spans are excluded from the model's view of the text but kept
//     verbatim in the report so the recruiter sees exactly what was found.
//   - AI-filler detection is advisory only: LLM-assisted résumés are legitimate
//     and detectors are unreliable. It never joins excludedFromModel.

const { scanInjection } = require("../utils/promptSafety");

const DEFENSE_VERSION = "2026-07-25.1";

function isEnabled() {
  return process.env.RESUME_DEFENSE_ENABLED !== "false" && process.env.RESUME_DEFENSE_ENABLED !== "0";
}

// ---------------------------------------------------------------------------
// Keyword stuffing.
//
// The incumbent-beating trick is a big block of delimiter-separated skill
// phrases with no support anywhere else in the document. Two independent
// signals, either fires:
//
//   (a) ONTOLOGY PATH — the block names ≥ STUFFING_MIN_ONTOLOGY recognised
//       technical skills (data/skills.json) that appear NOWHERE else in the
//       document. A legitimate technologist's skills section survives because
//       real experience bullets repeat its vocabulary ("built REST APIs in
//       Node.js…"); a teacher's legitimate skills section survives because
//       "lesson planning" is not a technology. Calibrated on the golden set:
//       the four stuffers score 8–10 uncorroborated ontology skills, the
//       highest benign fixture scores ≤ 4.
//   (b) GENERIC PATH — a large block (≥ STUFFING_MIN_PHRASES phrases) where
//       ≥ STUFFING_MIN_UNCORROBORATED of phrases have no token support
//       outside the block. Backstop for non-technical stuffing the ontology
//       cannot see. Threshold sits above the noisiest benign fixture (0.72).
// ---------------------------------------------------------------------------
const { findSkillsInText, canonicalizeSkill } = require("../utils/skillOntology");

const STUFFING_MIN_PHRASES = 12;
const STUFFING_MIN_UNCORROBORATED = 0.8;
const STUFFING_MIN_ONTOLOGY = 6;

const GENERIC_TOKENS = new Set([
  "and", "the", "with", "for", "basic", "design", "management", "development",
  "tools", "skills", "core", "professional", "experience", "knowledge",
]);

function phraseTokens(phrase) {
  return phrase
    .toLowerCase()
    .split(/[^a-z0-9+.#]+/)
    .filter((t) => t.length >= 3 && !GENERIC_TOKENS.has(t));
}

function stem(token) {
  return token.replace(/(?:ing|ed|es|s)$/, "");
}

function findDelimiterBlocks(text) {
  // Contiguous runs of lines where each line splits into ≥3 short phrases on
  // "|" or "," (a skills wall). Returns [{start, end, phrases: [String]}].
  const blocks = [];
  let current = null;
  let cursor = 0;
  for (const line of text.split("\n")) {
    const start = cursor;
    const end = start + line.length;
    cursor = end + 1;

    const body = line.replace(/^[-*•]\s*/, "").replace(/^[A-Za-z ]{2,24}:\s*/, "");
    const parts = body
      .split(/\s*[|,·]\s*/)
      .map((p) => p.trim())
      .filter((p) => p.length > 1 && p.length <= 40 && !/\d{4}/.test(p));
    const isDense = parts.length >= 3;

    if (isDense) {
      if (current) {
        current.end = end;
        current.phrases.push(...parts);
      } else {
        current = { start, end, phrases: [...parts] };
      }
    } else if (current) {
      blocks.push(current);
      current = null;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function detectStuffing(text) {
  const blocks = findDelimiterBlocks(text);
  const signals = [];
  for (const block of blocks) {
    const outside = (text.slice(0, block.start) + "\n" + text.slice(block.end)).toLowerCase();

    // (a) Ontology path: recognised technical skills in the block that appear
    // nowhere else in the document.
    const blockSkills = new Set();
    for (const phrase of block.phrases) {
      const direct = canonicalizeSkill(phrase);
      if (direct) blockSkills.add(direct);
      for (const [canonical] of findSkillsInText(phrase)) blockSkills.add(canonical);
    }
    const outsideSkills = new Set([...findSkillsInText(outside).keys()]);
    const uncorroboratedSkills = [...blockSkills].filter((s) => !outsideSkills.has(s));

    // (b) Generic path: token-level phrase corroboration.
    let uncorroborated = 0;
    const missing = [];
    for (const phrase of block.phrases) {
      const tokens = phraseTokens(phrase);
      const supported =
        tokens.length === 0 ||
        tokens.some((t) => {
          const st = stem(t);
          return st.length >= 3 && outside.includes(st);
        });
      if (!supported) {
        uncorroborated += 1;
        if (missing.length < 12) missing.push(phrase);
      }
    }
    const share = block.phrases.length > 0 ? uncorroborated / block.phrases.length : 0;

    // The ontology path additionally requires that the rest of the document is
    // essentially silent in the trade's vocabulary (outsideSkills ≤ 2): a real
    // engineer's experience bullets are saturated with recognised skills even
    // when their tools list adds a few uncorroborated names; a stuffer's
    // office-work history contains none. Golden-set calibration: stuffers are
    // 7–14 uncorroborated / 0 outside; benign worst cases are 6 / ≥ 5.
    const ontologyHit = uncorroboratedSkills.length >= STUFFING_MIN_ONTOLOGY && outsideSkills.size <= 2;
    const genericHit = block.phrases.length >= STUFFING_MIN_PHRASES && share >= STUFFING_MIN_UNCORROBORATED;
    if (!ontologyHit && !genericHit) continue;

    signals.push({
      code: "KEYWORD_STUFFING",
      severity: "warning",
      message: ontologyHit
        ? `A skill block names ${uncorroboratedSkills.length} recognised technologies (${uncorroboratedSkills
            .slice(0, 6)
            .join(", ")}…) that appear nowhere else in the document — consistent with keyword stuffing rather than a worked skill set.`
        : `A block of ${block.phrases.length} listed skills has ${Math.round(share * 100)}% with no support anywhere ` +
          `else in the document — consistent with keyword stuffing rather than a worked skill set.`,
      spans: [{ start: block.start, end: block.end, quote: text.slice(block.start, block.end) }],
      meta: {
        phrases: block.phrases.length,
        uncorroboratedShare: Number(share.toFixed(2)),
        uncorroboratedSkills,
        examples: missing,
      },
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------
// AI-generated filler — ADVISORY ONLY, never scored, never excluded.
// Conservative proxy: a high density of interchangeable corporate filler
// phrases. LLM-written résumés are legitimate; this is context, not a penalty.
// ---------------------------------------------------------------------------
const FILLER_PHRASES = [
  "results-oriented", "results-driven", "dynamic professional", "proven track record",
  "leverage synergies", "passionate about excellence", "go-getter", "self-starter",
  "thought leader", "cutting-edge solutions", "fast-paced environment", "team player",
  "detail-oriented professional", "excellent communication skills",
];
const FILLER_MIN_HITS = 6;

function detectFiller(text) {
  const lower = text.toLowerCase();
  let hits = 0;
  const found = [];
  for (const phrase of FILLER_PHRASES) {
    let idx = lower.indexOf(phrase);
    while (idx !== -1) {
      hits += 1;
      if (found.length < 6 && !found.includes(phrase)) found.push(phrase);
      idx = lower.indexOf(phrase, idx + phrase.length);
    }
  }
  if (hits < FILLER_MIN_HITS) return [];
  return [
    {
      code: "GENERIC_FILLER",
      severity: "advisory",
      message:
        `Unusually high density of template filler phrases (${hits} occurrences). This is context only — it is ` +
        `never scored and may simply reflect a professionally polished résumé.`,
      spans: [],
      meta: { hits, examples: found },
    },
  ];
}

// ---------------------------------------------------------------------------
// Hidden text — invisible unicode + (for PDFs) tiny-font and hidden-layer
// share from the extraction artifacts.
// ---------------------------------------------------------------------------
const INVISIBLE_CHAR_THRESHOLD = 5;
const HIDDEN_LAYER_SHARE = 0.1;

function detectHiddenText(artifacts = {}) {
  const signals = [];
  if ((artifacts.invisibleChars || 0) >= INVISIBLE_CHAR_THRESHOLD) {
    signals.push({
      code: "INVISIBLE_CHARACTERS",
      severity: "warning",
      message:
        `${artifacts.invisibleChars} zero-width or invisible characters were removed during extraction. A handful can ` +
        `come from copy-paste; this volume is consistent with hidden content.`,
      spans: [],
      meta: { invisibleChars: artifacts.invisibleChars },
    });
  }
  if ((artifacts.tinyFontChars || 0) > 0) {
    const share = artifacts.textLayerChars > 0 ? artifacts.tinyFontChars / artifacts.textLayerChars : 0;
    signals.push({
      code: "TINY_FONT_TEXT",
      severity: share >= HIDDEN_LAYER_SHARE ? "critical" : "warning",
      message:
        `${artifacts.tinyFontChars} characters are set below 4pt — effectively invisible when rendered. ` +
        `Samples are shown below.`,
      spans: [],
      meta: {
        tinyFontChars: artifacts.tinyFontChars,
        shareOfTextLayer: Number(share.toFixed(3)),
        samples: artifacts.tinyFontSamples || [],
      },
    });
  }
  return signals;
}

// ---------------------------------------------------------------------------
// Prompt injection — deterministic pattern pass (promptSafety.scanInjection).
// An optional LLM second pass on flagged blocks only can be enabled later via
// RESUME_DEFENSE_LLM=1; the deterministic pass is the load-bearing defence.
// ---------------------------------------------------------------------------
function detectInjection(text, blocks = []) {
  const hits = scanInjection(text);
  if (hits.length === 0) return [];
  const pageOf = (offset) => {
    for (const b of blocks) if (offset >= b.start && offset < b.end) return b.page || null;
    return null;
  };
  return [
    {
      code: "PROMPT_INJECTION",
      severity: "critical",
      message:
        `${hits.length} passage(s) contain instructions addressed to the screening system rather than a human reader. ` +
        `They were excluded from automated analysis and are quoted below.`,
      spans: hits.map((h) => ({ start: h.start, end: h.end, quote: h.quote, page: pageOf(h.start) })),
      meta: { rules: [...new Set(hits.flatMap((h) => h.ruleIds))] },
    },
  ];
}

// ---------------------------------------------------------------------------
// analyze — the single entry point.
// ---------------------------------------------------------------------------
function analyze({ text, blocks = [], artifacts = {} } = {}) {
  const analyzedAt = new Date();
  if (!isEnabled() || !text) {
    return { version: DEFENSE_VERSION, analyzedAt, engine: "disabled", signals: [], excludedFromModel: [], clean: true };
  }

  const signals = [
    ...detectInjection(text, blocks),
    ...detectStuffing(text),
    ...detectHiddenText(artifacts),
    ...detectFiller(text),
  ];

  // Only active-manipulation content is withheld from the model: injected
  // instructions. Stuffed skill blocks stay visible (they are real text a
  // human can also read — the report flags them; hiding them would make the
  // extraction blind to something the recruiter can see).
  const excludedFromModel = signals
    .filter((s) => s.code === "PROMPT_INJECTION")
    .flatMap((s) => s.spans.map((sp) => ({ start: sp.start, end: sp.end, quote: sp.quote, codes: [s.code] })));

  return {
    version: DEFENSE_VERSION,
    analyzedAt,
    engine: "deterministic",
    signals,
    excludedFromModel,
    clean: signals.filter((s) => s.severity !== "advisory").length === 0,
  };
}

module.exports = { analyze, isEnabled, DEFENSE_VERSION };
