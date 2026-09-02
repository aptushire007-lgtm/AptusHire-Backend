// Application autofill — résumé → SUGGESTED form fields, every one of them cited.
//
// This is deliberately not "parse the résumé and fill the form". The incumbent
// version of that feature launders a parser's output into a human attestation:
// the candidate skims, submits, and a machine's reading of the document becomes
// legally *their claim*, indistinguishable from something they typed.
//
// What this produces instead is a set of PROPOSALS, each carrying the verbatim
// span it came from:
//
//   canonical text (immutable, from ingest)
//     → hostility spans      [resumeDefenseService]
//     → model view           [promptSafety.buildModelView — offsets preserved]
//     → model text           [claimService.collapseView — byte-identical framing]
//     → raw suggestions      [LLM, job-blind, quotes only — autofillPrompts]
//     → verified suggestions [spanVerifier: cite-or-DROP, in code]
//     → deterministic merge  [regex contacts, which need no model at all]
//
// Guarantees this buys, in order of how much they matter:
//   1. A suggestion the candidate sees can always be traced to a quote from
//      their own document. Anything else was dropped before it reached them.
//   2. Injected content is structurally unsuggestable: the defense pass blanks
//      it out of the model view, so any field derived from it fails span
//      verification exactly the way a hallucination does.
//   3. Extraction is job-blind, so suggestions cannot vary by employer. That is
//      what makes the cross-job cache on Resume.autofill sound.
//
// Nothing here writes to a Candidate, and nothing here decides anything. The
// candidate accepts, edits, or discards every field; provenance for what they
// chose is recorded at submit time by the apply controller.

const crypto = require("crypto");
const CompanySettings = require("../models/CompanySettings");
const llm = require("./llmService");
const usageService = require("./usageService");
const { notifyAdmin } = require("./notificationService");
const resumeDefenseService = require("./resumeDefenseService");
const { collapseView } = require("./claimService");
const { resolveRole } = require("../config/models");
const { buildBlocks } = require("../utils/textNormalize");
const { buildModelView } = require("../utils/promptSafety");
const { locateQuote } = require("../utils/spanVerifier");
const { canonicalizeSkill, cleanTerm } = require("../utils/skillOntology");
const {
  AUTOFILL_PROMPT_VERSION,
  AUTOFILL_SYSTEM,
  AUTOFILL_SCHEMA,
  autofillPrompt,
} = require("../utils/autofillPrompts");

const AUTOFILL_VERSION = "2026-07-31.1";
const PROVIDER = "openrouter";

// Characters of surrounding document shown either side of a quote, so the
// candidate can see a snippet in situ rather than a decontextualised fragment.
const CONTEXT_CHARS = 90;

// Per-section caps. The schema already caps the model; these bound what survives
// verification, so a stuffed document cannot produce a 200-row form.
const SECTION_CAPS = { experience: 20, education: 10, projects: 15, certificates: 15, skills: 50 };

function isEnabled() {
  const v = process.env.AUTOFILL_ENABLED;
  return v !== "false" && v !== "0";
}

function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Deterministic extraction. Runs ALWAYS — including when the LLM is unavailable
// — because contact details are exactly matchable and spending a model call on
// a regex would be silly. Each hit carries its own span, same contract as the
// model-derived suggestions, so the UI renders them identically.
// ---------------------------------------------------------------------------
const CONTACT_PATTERNS = {
  linkedinUrl: /\b(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_%-]+\/?/i,
  githubUrl: /\b(?:https?:\/\/)?(?:www\.)?github\.com\/[A-Za-z0-9_-]+\/?/i,
  siteUrl: /\bhttps?:\/\/(?!(?:[a-z]{2,3}\.)?linkedin\.com|(?:www\.)?github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:\/[^\s)]*)?/i,
};

// Match against the VIEW, never the raw text: a phone number or URL sitting
// inside an injected instruction block has been blanked there, so it cannot be
// suggested. Same rule as every other extraction path.
function findContact(view, canonicalText, re) {
  const m = re.exec(view);
  if (!m) return null;
  return spanAt(canonicalText, m.index, m.index + m[0].length);
}

function spanAt(canonicalText, start, end) {
  return {
    start,
    end,
    quote: canonicalText.slice(start, end),
    context: {
      before: canonicalText.slice(Math.max(0, start - CONTEXT_CHARS), start),
      after: canonicalText.slice(end, Math.min(canonicalText.length, end + CONTEXT_CHARS)),
    },
  };
}

function deterministicBasics(view, canonicalText) {
  const out = {};
  const linkedin = findContact(view, canonicalText, CONTACT_PATTERNS.linkedinUrl);
  if (linkedin) out.linkedinUrl = { value: linkedin.quote.replace(/\/$/, ""), spans: [linkedin], origin: "deterministic" };

  // A personal site beats a GitHub profile for "portfolio" when both exist, but
  // GitHub is the far more common answer, so it is the fallback rather than the
  // other way round.
  const site = findContact(view, canonicalText, CONTACT_PATTERNS.siteUrl);
  const github = findContact(view, canonicalText, CONTACT_PATTERNS.githubUrl);
  const portfolio = site || github;
  if (portfolio) out.portfolioUrl = { value: portfolio.quote.replace(/\/$/, ""), spans: [portfolio], origin: "deterministic" };

  return out;
}

// ---------------------------------------------------------------------------
// Verification. The model emits quotes (strings); code turns them into offsets
// and drops what does not locate — spanVerifier.locateQuote is the same matcher
// the ClaimGraph uses, so autofill and screening agree on what "cited" means.
// ---------------------------------------------------------------------------
function verifySpans(rawQuotes, view, canonicalText) {
  const spans = [];
  for (const q of (Array.isArray(rawQuotes) ? rawQuotes : []).slice(0, 3)) {
    const loc = locateQuote(view, q);
    if (!loc) continue;
    spans.push(spanAt(canonicalText, loc.start, loc.end));
  }
  return spans;
}

function str(v, max = 2000) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

/**
 * Verify one section: keep entries that (a) cite at least one locatable quote
 * and (b) carry at least one non-empty required field. Returns the surviving
 * entries plus a drop count — the drop rate is a quality metric, not noise, and
 * a rising one means the extractor is drifting.
 */
function verifySection(rawEntries, { view, canonicalText, fields, requiredAnyOf, cap }) {
  const kept = [];
  let dropped = 0;

  for (const raw of (Array.isArray(rawEntries) ? rawEntries : []).slice(0, cap * 2)) {
    const spans = verifySpans(raw?.quotes, view, canonicalText);
    if (spans.length === 0) {
      dropped += 1;
      continue;
    }
    const value = {};
    for (const [key, max] of Object.entries(fields)) {
      value[key] = typeof max === "boolean" ? Boolean(raw?.[key]) : str(raw?.[key], max);
    }
    if (!requiredAnyOf.some((k) => value[k])) {
      dropped += 1;
      continue;
    }
    kept.push({ value, spans });
    if (kept.length >= cap) break;
  }

  return { entries: kept, dropped };
}

function verifySkills(rawSkills, { view, canonicalText }) {
  const kept = [];
  const seen = new Set();
  let dropped = 0;

  for (const raw of (Array.isArray(rawSkills) ? rawSkills : []).slice(0, SECTION_CAPS.skills * 2)) {
    // The surface form the document used is what the candidate sees — "Go", not
    // "go". cleanTerm lowercases for ontology lookup, so it is used ONLY to
    // build the dedupe key, never as the displayed value.
    const name = str(raw?.name, 80).replace(/\s+/g, " ");
    const cleaned = cleanTerm(name);
    if (!name || !cleaned) {
      dropped += 1;
      continue;
    }
    // Dedupe on the ONTOLOGY id where one exists, so "Node", "Node.js" and
    // "NodeJS" collapse to one suggestion instead of three chips for the same
    // thing — whichever spelling the document used first is the one offered.
    const key = canonicalizeSkill(cleaned) || cleaned;
    if (seen.has(key)) continue;

    const spans = verifySpans(raw?.quotes, view, canonicalText);
    if (spans.length === 0) {
      dropped += 1;
      continue;
    }
    seen.add(key);
    kept.push({ value: { name }, spans });
    if (kept.length >= SECTION_CAPS.skills) break;
  }

  return { entries: kept, dropped };
}

// ---------------------------------------------------------------------------
// PURE core (exported for offline tests): raw model output + canonical text in,
// verified suggestion payload out. No I/O, no DB, no clock.
// ---------------------------------------------------------------------------
function buildSuggestions({ canonicalText, exclusions, raw }) {
  const { view } = buildModelView(canonicalText, exclusions);

  const experience = verifySection(raw?.experience, {
    view,
    canonicalText,
    fields: { company: 200, role: 200, startDate: 40, endDate: 40, currentlyWorking: true, description: 4000 },
    requiredAnyOf: ["company", "role"],
    cap: SECTION_CAPS.experience,
  });
  const education = verifySection(raw?.education, {
    view,
    canonicalText,
    fields: { institution: 200, degree: 200, fieldOfStudy: 200, startYear: 20, endYear: 20, grade: 40 },
    requiredAnyOf: ["institution", "degree"],
    cap: SECTION_CAPS.education,
  });
  const projects = verifySection(raw?.projects, {
    view,
    canonicalText,
    fields: { title: 200, description: 4000, techStack: 400, link: 400 },
    requiredAnyOf: ["title"],
    cap: SECTION_CAPS.projects,
  });
  const certificates = verifySection(raw?.certificates, {
    view,
    canonicalText,
    fields: { name: 200, issuer: 200, issueDate: 40, credentialUrl: 400 },
    requiredAnyOf: ["name"],
    cap: SECTION_CAPS.certificates,
  });
  const skills = verifySkills(raw?.skills, { view, canonicalText });

  // Basics: deterministic regex wins over the model for URLs (an exact match
  // beats a transcription), and the model only supplies what regex cannot —
  // a human-written location line.
  const basics = deterministicBasics(view, canonicalText);
  const basicsSpans = verifySpans(raw?.basics?.quotes, view, canonicalText);
  const location = str(raw?.basics?.location, 120);
  if (location && basicsSpans.length > 0) {
    basics.location = { value: location, spans: basicsSpans, origin: "ai" };
  }
  for (const key of ["linkedinUrl", "portfolioUrl"]) {
    if (basics[key]) continue;
    const v = str(raw?.basics?.[key], 400);
    if (v && basicsSpans.length > 0) basics[key] = { value: v, spans: basicsSpans, origin: "ai" };
  }

  return {
    sections: {
      basics,
      experience: experience.entries,
      education: education.entries,
      projects: projects.entries,
      certificates: certificates.entries,
      skills: skills.entries,
    },
    stats: {
      dropped: {
        experience: experience.dropped,
        education: education.dropped,
        projects: projects.dropped,
        certificates: certificates.dropped,
        skills: skills.dropped,
      },
    },
  };
}

// Degraded-state labels, one per cause.
//
// These strings are the candidate's ONLY signal that the form below them is
// blank because the reader failed, not because their document was empty — so
// they are defined once and reused, never retyped at a call site. Two of them
// were briefly byte-identical, which made an unconfigured deployment and an
// exhausted account indistinguishable on screen: the same misdirection rule 5
// exists to prevent, reintroduced one layer down.
//
// They differ because what the READER should do differs. "Try again" is honest
// advice for a one-off parse failure and a lie for the other two, and a message
// that invites a doomed retry is worse than one that admits nothing will help.
const DEGRADED = {
  // No provider configured for this deployment. Not an incident, not transient.
  notConfigured: {
    reason: "llm_not_configured",
    message:
      "Automatic reading is not enabled here, so only contact details were detected. The work history, " +
      "education, and skills sections below have NOT been filled in — please complete them yourself.",
  },
  // Provider account out of credit. Nothing the candidate does changes this, so
  // the message must not imply otherwise; an operator has been alerted.
  noCredits: {
    reason: "llm_no_credits",
    message:
      "Automatic reading is temporarily unavailable, so only contact details were detected. Re-uploading " +
      "will not help — the work history, education, and skills sections below have NOT been filled in, so " +
      "please complete them yourself. Your application is not affected.",
  },
  // This document, this time. Retrying is genuinely worth a try here.
  extractionFailed: {
    reason: "extraction_failed",
    message:
      "The résumé could not be read automatically this time, so only contact details were detected. Please " +
      "fill in the rest yourself — your application is not affected.",
  },
};

// One operator alert per outage per tenant, not one per application. Keyed on
// the outage's start timestamp (stable for its whole duration), so a top-up
// followed by a fresh outage does alert again. The map write happens before the
// first await, so concurrent applications cannot race past it.
const creditAlertSentFor = new Map();

async function alertCreditOutage(company) {
  const since = llm.creditOutageSince();
  if (!company || !since) return;
  const key = String(company);
  if (creditAlertSentFor.get(key) === since) return;
  creditAlertSentFor.set(key, since);
  await notifyAdmin({
    companyId: company,
    type: "system_alert",
    title: "AI provider out of credit — autofill and scoring degraded",
    message:
      "The AI provider account has no credit left, so résumé autofill is returning contact details only and " +
      "every other AI path is falling back to its deterministic engine. Candidates are told the reading was " +
      "incomplete. Top up the account to restore full extraction; no candidate outcome was decided by the " +
      "degraded path.",
    meta: { reason: "llm_no_credits", outageSince: new Date(since) },
  }).catch((e) => console.error("Could not send credit-outage alert:", e.message));
}

// Empty-but-valid payload, used for every degraded path so callers never have
// to branch on shape — only on `degraded`.
function emptyPayload({ engine, degraded }) {
  return {
    version: AUTOFILL_VERSION,
    promptVersion: AUTOFILL_PROMPT_VERSION,
    engine,
    // Copied, not aliased: the DEGRADED entries are shared module constants, and
    // this payload is handed to a caller and persisted as a Mixed subdocument.
    // One mutation through either route would rewrite the label every later
    // candidate sees.
    degraded: degraded ? { ...degraded } : null,
    sections: { basics: {}, experience: [], education: [], projects: [], certificates: [], skills: [] },
    stats: { dropped: {} },
    notices: [],
  };
}

/**
 * Suggest form fields for one résumé in the caller's library.
 *
 * Returns the payload described above. NEVER throws for an unavailable model:
 * a degraded run returns the deterministic result LABELLED as degraded, because
 * a partial parse rendered as a complete one is exactly the failure mode the
 * uncertainty rule exists to prevent.
 */
async function suggestForResume(resume, { company } = {}) {
  if (!isEnabled()) {
    return emptyPayload({
      engine: "deterministic",
      degraded: { reason: "autofill_disabled", message: "Autofill is turned off. Please fill the form in yourself." },
    });
  }

  const canonicalText = resume.extractedText || "";
  if (!canonicalText.trim()) {
    return emptyPayload({
      engine: "deterministic",
      degraded: {
        reason: "no_text",
        message:
          "No text could be read from this file — it may be a scan or an image. Please fill the form in yourself, " +
          "or upload a text-based PDF or DOCX.",
      },
    });
  }

  const textHash = resume.textHash || sha256(canonicalText);

  // Cache hit: same document, same pipeline version. Extraction is job-blind, so
  // a hit across two different employers is correct rather than a leak.
  const cached = resume.autofill;
  if (
    cached &&
    cached.textHash === textHash &&
    cached.version === AUTOFILL_VERSION &&
    cached.promptVersion === AUTOFILL_PROMPT_VERSION &&
    cached.payload
  ) {
    return { ...cached.payload, cached: true };
  }

  // Same defense pass the ATS runs, over the same coordinate space — blocks are
  // rebuilt from stored pageBreaks rather than re-parsing the file, because
  // re-parsing would re-normalise the text and move every offset.
  const blocks = buildBlocks(canonicalText, resume.pageBreaks || []);
  const hostility = resumeDefenseService.analyze({
    text: canonicalText,
    blocks,
    artifacts: (resume.artifacts && resume.artifacts.toObject?.()) || resume.artifacts || {},
  });
  const exclusions = (hostility.excludedFromModel || []).map((e) => ({ start: e.start, end: e.end }));

  const notices = [];
  if (exclusions.length > 0) {
    // Neutral, non-accusatory, and deliberately vague about the detector: the
    // candidate is told their file was partly excluded (they may not have
    // written it — templates and CV-builders inject text too), not accused.
    notices.push({
      code: "content_excluded",
      message:
        `${exclusions.length} passage(s) in this file look like instructions addressed to an automated system rather ` +
        `than to a human reader, so they were left out of the automated reading. Anything they contained will not be ` +
        `suggested below — add it yourself if it belongs in your application.`,
    });
  }

  const { view } = buildModelView(canonicalText, exclusions);
  const modelText = collapseView(view);

  if (!llm.isEnabled()) {
    const payload = {
      ...emptyPayload({ engine: "deterministic", degraded: DEGRADED.notConfigured }),
      notices,
    };
    payload.sections.basics = deterministicBasics(view, canonicalText);
    return payload;
  }

  const settings = company ? await CompanySettings.findOne({ company }).select("ai") : null;
  const resolved = resolveRole("extraction", settings);

  let data;
  let model;
  let usage;
  let cacheHit;
  const t0 = Date.now();
  try {
    ({ data, usage, model, cached: cacheHit } = await llm.generateJSON({
      system: AUTOFILL_SYSTEM,
      prompt: autofillPrompt(modelText),
      schema: AUTOFILL_SCHEMA,
      maxTokens: 4096,
      model: resolved.model,
      temperature: 0,
      promptVersion: AUTOFILL_PROMPT_VERSION,
    }));
  } catch (err) {
    // Autofill is a convenience. It degrades; it never blocks an application.
    //
    // An exhausted provider account is separated from a failed read because the
    // two need opposite responses. "Could not be read THIS TIME" invites a retry
    // that is guaranteed to fail, and points the candidate — and anyone
    // debugging — at the résumé, when the résumé was never the problem. A credit
    // outage is an operator action, so a recruiter is told (once per outage, not
    // once per application) rather than it running unnoticed behind a log line.
    const outOfCredits = err.code === "LLM_NO_CREDITS";
    console.warn(`[autofill] extraction failed for resume ${resume._id}: ${err.code || err.message}`);
    if (outOfCredits) await alertCreditOutage(company);
    const payload = {
      ...emptyPayload({
        engine: "deterministic",
        degraded: outOfCredits ? DEGRADED.noCredits : DEGRADED.extractionFailed,
      }),
      notices,
    };
    payload.sections.basics = deterministicBasics(view, canonicalText);
    return payload;
  }

  if (company) {
    await usageService.recordUsage({
      company,
      kind: "autofill",
      provider: PROVIDER,
      model,
      usage,
      latencyMs: Date.now() - t0,
      engine: "ai",
      promptVersion: AUTOFILL_PROMPT_VERSION,
      cached: cacheHit,
    });
  }

  const built = buildSuggestions({ canonicalText, exclusions, raw: data });
  const totalDropped = Object.values(built.stats.dropped).reduce((a, b) => a + b, 0);
  if (totalDropped > 0) {
    console.warn(`[autofill] dropped ${totalDropped} uncitable suggestion(s) for resume ${resume._id} (cite-or-drop)`);
  }

  const payload = {
    version: AUTOFILL_VERSION,
    promptVersion: AUTOFILL_PROMPT_VERSION,
    engine: "ai",
    degraded: null,
    sections: built.sections,
    stats: built.stats,
    notices,
  };

  // Best-effort cache write — a failure here costs a repeat call, not a request.
  try {
    resume.autofill = { textHash, version: AUTOFILL_VERSION, promptVersion: AUTOFILL_PROMPT_VERSION, engine: "ai", payload, at: new Date() };
    resume.markModified("autofill"); // `payload` is Mixed — mongoose can't diff it
    await resume.save();
  } catch (err) {
    console.warn(`[autofill] could not cache suggestions for resume ${resume._id}: ${err.message}`);
  }

  return payload;
}

// ---------------------------------------------------------------------------
// Provenance attribution.
//
// Computed HERE, on the server, by diffing what the candidate submitted against
// the suggestions we cached for their résumé. Deliberately not taken from the
// client: a submitted "I typed all of this myself" flag is worth nothing, and
// the whole point of the record is to preserve a distinction a client has an
// incentive to erase.
//
// Matching is by the entry's identifying fields (an employer + role, an
// institution + degree, a project title). If the candidate kept the identity but
// changed a date or a description, that is an EDIT — still traceable to the
// cited span, but no longer a verbatim acceptance.
// ---------------------------------------------------------------------------
const IDENTITY_FIELDS = {
  experience: ["company", "role"],
  education: ["institution", "degree"],
  projects: ["title"],
  certificates: ["name"],
};

function norm(v) {
  return String(v == null ? "" : v).trim().toLowerCase().replace(/\s+/g, " ");
}

function identityKey(section, entry) {
  return IDENTITY_FIELDS[section].map((f) => norm(entry?.[f])).join(" ");
}

// Verbatim means every field the suggestion proposed still holds the proposed
// value. Fields the candidate ADDED (the suggestion left blank) don't demote it
// to an edit — filling a gap is not changing what the machine said.
function isVerbatim(submitted, suggested) {
  for (const [key, value] of Object.entries(suggested)) {
    if (value === "" || value === false) continue;
    if (typeof value === "boolean" ? Boolean(submitted?.[key]) !== value : norm(submitted?.[key]) !== norm(value)) {
      return false;
    }
  }
  return true;
}

function bareSpans(spans) {
  return (spans || []).map((s) => ({ start: s.start, end: s.end, quote: s.quote }));
}

/**
 * Attribute a submitted application against the suggestions offered for its
 * résumé. Returns the submitted arrays with a `provenance` stamped on every
 * entry, a parallel skillProvenance array, and the counters for the summary
 * record. Pure — exported for tests.
 *
 * With no payload (autofill unavailable, or the candidate never used it) every
 * entry is attributed to the candidate, which is the correct reading: they typed it.
 */
function attributeProvenance(submitted, payload) {
  const sections = payload?.sections || {};
  const promptVersion = payload?.promptVersion;
  const counts = { suggested: 0, accepted: 0, edited: 0, discarded: 0 };

  const out = {};
  for (const section of Object.keys(IDENTITY_FIELDS)) {
    const suggestions = Array.isArray(sections[section]) ? sections[section] : [];
    counts.suggested += suggestions.length;

    // Each suggestion may be claimed once — two real roles at the same employer
    // with the same title must not both match the single suggestion for it.
    const pool = new Map();
    suggestions.forEach((s, i) => {
      const key = identityKey(section, s.value);
      if (!pool.has(key)) pool.set(key, []);
      pool.get(key).push(i);
    });
    const claimed = new Set();

    out[section] = (Array.isArray(submitted[section]) ? submitted[section] : []).map((entry) => {
      const queue = pool.get(identityKey(section, entry));
      const idx = (queue || []).find((i) => !claimed.has(i));
      if (idx === undefined) {
        return { ...entry, provenance: { source: "candidate", spans: [] } };
      }
      claimed.add(idx);
      const match = suggestions[idx];
      const verbatim = isVerbatim(entry, match.value);
      if (verbatim) counts.accepted += 1;
      else counts.edited += 1;
      return {
        ...entry,
        provenance: {
          source: verbatim ? "autofill_accepted" : "autofill_edited",
          spans: bareSpans(match.spans),
          promptVersion,
        },
      };
    });

    counts.discarded += suggestions.length - claimed.size;
  }

  // Skills carry no separate identity — the value IS the identity.
  const skillSuggestions = Array.isArray(sections.skills) ? sections.skills : [];
  counts.suggested += skillSuggestions.length;
  const byName = new Map(skillSuggestions.map((s) => [norm(s.value.name), s]));
  const usedSkills = new Set();

  out.skillProvenance = (Array.isArray(submitted.skills) ? submitted.skills : []).map((value) => {
    const match = byName.get(norm(value));
    if (!match) return { value, source: "candidate", spans: [] };
    usedSkills.add(norm(value));
    counts.accepted += 1;
    return { value, source: "autofill_accepted", spans: bareSpans(match.spans) };
  });
  counts.discarded += skillSuggestions.length - usedSkills.size;

  return { ...out, skillProvenance: out.skillProvenance, counts };
}

module.exports = {
  isEnabled,
  suggestForResume,
  buildSuggestions,
  deterministicBasics,
  attributeProvenance,
  DEGRADED,
  AUTOFILL_VERSION,
  AUTOFILL_PROMPT_VERSION,
};
