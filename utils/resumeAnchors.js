// Résumé anchors — required coverage derived from the candidate's own document, in code.
//
// THE FAILURE THIS FIXES. "The interview never asks anything from my résumé." That is true, and
// the reason is structural rather than a bad prompt.
//
// The résumé is *supposed* to reach the interview through the Claim → Probe → Verdict loop:
// evidenceAtsService extracts a ClaimGraph, the scorer marks the high-weight claims it could not
// verify, and probeService turns each of those into a required interview question. That chain has
// a gate at the very top — evidenceAtsService.runEvidenceAssessment throws NO_APPROVED_RUBRIC
// unless a human has approved a RoleRubric FOR THAT JOB. No rubric, no assessment; no assessment,
// no unverifiedHighWeightClaims; and probeService.generateProbesForSession then returns
// `{ probes: [], engine: "none" }` on its first line. The interview runs with zero questions
// derived from the document, and — worse — looks exactly like one that ran with them.
//
// So the résumé reaching the interview was conditional on a configuration step that most jobs
// never complete. This module removes that condition. It needs no rubric, no ClaimGraph, no
// assessment and no model: it reads the résumé the candidate actually uploaded and produces a
// short list of concrete things they claimed, each pinned to a verbatim span of the document.
//
// WHAT THIS IS AND IS NOT. It is NOT a replacement for claim-probes and must never be described as
// one. A probe knows WHY a claim matters (it is tied to a weighted rubric criterion) and carries
// precomputed verify/contradict conditions, so its answer can move a score. An anchor knows only
// that the candidate wrote this down and the job appears to care about it, so an anchor can do
// exactly one thing: guarantee the interview ASKED. Anchors are therefore required coverage and
// never evidence — nothing here reaches a score. When probes exist they take precedence and
// anchors fill whatever coverage is left; see aiInterviewService.
//
// WHY DETERMINISTIC. Which parts of a résumé get interrogated is a decision about how a candidate
// is treated, so two runs over the same document must select the same things or the record is not
// reproducible. It is also the difference between "the model happened to notice Kubernetes" and
// "this interview covered 3 of the 3 résumé topics the job asks about", which is the claim a buyer
// can check.
//
// CITE OR DROP. Every anchor carries a `quote` that is verified to be a literal substring of the
// canonical résumé text (spanVerifier.locateQuote) before it is kept. An anchor we cannot point at
// in the document is dropped, not asked about — the same rule the extractor lives under, and the
// reason a candidate can never be asked to account for something their résumé does not say.

const { locateQuote } = require("./spanVerifier");

// Bump when selection changes — which topics an interview was required to cover is part of the
// instrument, and a stored session records the version that chose them.
const ANCHOR_SELECTION_VERSION = "2026-08-18.1";

// How many anchors one interview may be required to cover. Small on purpose. Every anchor is a
// question the interview MUST spend, and required coverage that does not fit inside the length
// cap forces the cap upwards (aiInterviewService raises maxQuestions rather than dropping
// coverage) — so a generous number here silently turns a 20-minute interview into a 40-minute one.
// §3.2: raised from 3 to 5 in the same commit as interviewPrompts.js's résumé-excerpt budget going
// from 1500 to 6000 chars — the two defects ("not asking from résumé" and "last two roles outside
// the window") share one root cause, and the auto-raise of maxQuestions above is exactly what
// keeps this increase from silently ballooning interview length: coverage is never dropped, so the
// budget grows with it, deliberately, rather than the anchor being dropped to fit.
const MAX_ANCHORS = Number(process.env.INTERVIEW_RESUME_ANCHORS || 5);

// An anchor term shorter than this is not a topic, it is a fragment — "AI", "QA", "C" are real
// but they match everywhere and a question built on one is not recognisably about the résumé.
// Two-letter terms are admitted only when they appear in the job's required skills, where the
// job itself has vouched for them being meaningful.
const MIN_TERM_CHARS = 3;

// Weights decide ORDER, not score. They encode one judgement, made once, in the open: a thing the
// job asked for and the candidate claims is worth more interview time than a thing only one side
// mentioned. Nothing downstream reads these numbers.
const WEIGHTS = {
  project_required_skill: 100, // a project built with something the job requires
  experience_required_skill: 90, // a job where they used something the job requires
  required_skill: 80, // a required skill claimed on the résumé, unattached
  project: 60, // a named project the job says nothing about
  experience: 50, // a named employer
  certification: 30,
};

function norm(value) {
  return String(value || "").trim();
}

function lower(value) {
  return norm(value).toLowerCase();
}

// Whole-word, case-insensitive containment. A required skill of "Go" must not match "Google", and
// "R" must not match every capital R in the document — the same word-edge discipline
// utils/groundedAck uses for the spoken lead-in, for the same reason.
function mentions(haystack, term) {
  const t = norm(term);
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = /^[A-Za-z0-9]/.test(t) ? "(?<![A-Za-z0-9])" : "";
  const suffix = /[A-Za-z0-9]$/.test(t) ? "(?![A-Za-z0-9])" : "";
  return new RegExp(prefix + escaped + suffix, "i").test(String(haystack || ""));
}

/**
 * The sentence-ish window of `text` around the first whole-word occurrence of `term`, trimmed to
 * `maxChars`. This is what gets quoted back as the anchor's evidence, so it is taken from the
 * document rather than composed: an anchor must be able to show where in the résumé it came from.
 * Returns "" when the term is not present as a whole word.
 */
function windowAround(text, term, maxChars = 180) {
  const source = String(text || "");
  const t = norm(term);
  if (!source || !t) return "";
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const prefix = /^[A-Za-z0-9]/.test(t) ? "(?<![A-Za-z0-9])" : "";
  const suffix = /[A-Za-z0-9]$/.test(t) ? "(?![A-Za-z0-9])" : "";
  const match = new RegExp(prefix + escaped + suffix, "i").exec(source);
  if (!match) return "";
  // Widen to the surrounding line/sentence, then clamp. Résumés are bullet lists far more often
  // than prose, so a newline is a better boundary than a full stop and is checked first.
  const half = Math.floor(maxChars / 2);
  let start = Math.max(0, match.index - half);
  let end = Math.min(source.length, match.index + t.length + half);
  const nl = source.lastIndexOf("\n", match.index);
  if (nl >= 0 && match.index - nl < maxChars) start = nl + 1;
  const nlEnd = source.indexOf("\n", match.index);
  if (nlEnd >= 0 && nlEnd - match.index < maxChars) end = nlEnd;
  return source.slice(start, end).trim();
}

// ---------------------------------------------------------------------------
// Candidate → candidate anchors (before verification)
// ---------------------------------------------------------------------------

function requiredSkillsOf(job) {
  const explicit = (job?.requiredSkills || []).map(norm).filter(Boolean);
  return Array.from(new Map(explicit.map((s) => [s.toLowerCase(), s])).values());
}

/**
 * Every candidate anchor the structured résumé fields support, unranked and unverified.
 *
 * Reads the STRUCTURED fields (experience/projects/skills) rather than parsing the raw text,
 * because those were produced by the extraction pipeline and are already the codebase's answer to
 * "what does this document say". The raw text is used only to prove the term is really in the
 * document — which is the check that makes the structured fields safe to trust here.
 */
function candidateAnchors(candidate, job) {
  const required = requiredSkillsOf(job);
  const requiredLower = new Set(required.map((s) => s.toLowerCase()));
  const out = [];

  const projects = candidate?.projects || [];
  for (const project of projects) {
    const title = norm(project?.title);
    if (!title) continue;
    const stack = norm(project?.techStack);
    const description = norm(project?.description);
    const blob = [title, stack, description].filter(Boolean).join(" ");
    // Which of the job's required skills this project claims. The FIRST one decides the anchor's
    // term, because that is what the question will be built to name.
    const hit = required.find((skill) => mentions(blob, skill));
    out.push({
      kind: hit ? "project_required_skill" : "project",
      term: title,
      // What the interview should ask ABOUT — the project, optionally narrowed to the required
      // skill the job actually cares about.
      focus: hit || "",
      source: "projects",
      weight: hit ? WEIGHTS.project_required_skill : WEIGHTS.project,
    });
  }

  const experience = candidate?.experience || [];
  for (const role of experience) {
    const company = norm(role?.company);
    const title = norm(role?.role);
    if (!company && !title) continue;
    const blob = [title, company, norm(role?.description)].filter(Boolean).join(" ");
    const hit = required.find((skill) => mentions(blob, skill));
    out.push({
      kind: hit ? "experience_required_skill" : "experience",
      term: company || title,
      focus: hit || title,
      source: "experience",
      weight: hit ? WEIGHTS.experience_required_skill : WEIGHTS.experience,
    });
  }

  // Required skills the candidate claims but attached to nothing the structured fields captured.
  // These are the highest-risk claims on any résumé — a skill listed in a comma-separated band at
  // the top, with no project and no employer behind it — which is exactly why the interview should
  // ask rather than assume either way.
  const claimed = new Set((candidate?.skills || []).map(lower));
  for (const skill of required) {
    if (!claimed.has(skill.toLowerCase())) continue;
    if (skill.length < MIN_TERM_CHARS && !requiredLower.has(skill.toLowerCase())) continue;
    const alreadyCovered = out.some((a) => a.focus && a.focus.toLowerCase() === skill.toLowerCase());
    if (alreadyCovered) continue;
    out.push({ kind: "required_skill", term: skill, focus: skill, source: "skills", weight: WEIGHTS.required_skill });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Criterion binding (REPORT-REDESIGN A1)
// ---------------------------------------------------------------------------

/**
 * Which rubric criterion, if any, this anchor is evidence toward. Deterministic on purpose —
 * anchors exist to be reproducible with no model call, and the binding inherits that rule. The
 * plan suggested reusing services/evidenceMatcher here, but that module IS a model call; the
 * thing actually worth reusing is `mentions`' word-edge discipline, so the test is simply: does
 * the criterion's human-written label name this anchor's focus (or term) as a whole word?
 *
 * Weightiest criterion wins a tie, so an anchor about "Python" binds to the 9% Python criterion
 * rather than an incidental mention in a lighter one. Returns "" when nothing matches — an
 * unbound anchor behaves exactly as every anchor did before this existed.
 *
 * The consumer contract is deliberately weak (interviewReportEngine.buildCoverageMatrix): a
 * COVERED anchor may move that criterion's interview cell from untested to partial, only. It can
 * never produce verified or contradicted — those require a probe verdict with a code-verified
 * quote. An anchor proves the subject came up; it proves nothing about the answer.
 */
function criterionForAnchor(anchor, criteria) {
  const ranked = (criteria || [])
    .filter((c) => c && c.criterionId && c.label)
    .slice()
    .sort((a, b) => (b.weight || 0) - (a.weight || 0));
  for (const c of ranked) {
    if (anchor.focus && mentions(c.label, anchor.focus)) return c.criterionId;
    if (mentions(c.label, anchor.term)) return c.criterionId;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Choose the anchors this interview is required to cover.
 *
 * Verified (the term must be a literal whole-word substring of `resumeText`), deduplicated on the
 * term, ranked by weight with the résumé's own order as the tie-break, and capped. The tie-break
 * is the document order rather than anything derived from the candidate, so two candidates with
 * identically-weighted anchors are treated identically.
 *
 * `criteria` (optional) is the screening assessment's criterionFindings — when present, each
 * selected anchor is bound to the criterion it evidences (see criterionForAnchor). Absent or
 * empty means every anchor gets criterionId "" and nothing else changes.
 *
 * @returns {{anchors: Array, dropped: Array, version: string}}
 */
function selectAnchors(candidate, job, { max = MAX_ANCHORS, criteria = [] } = {}) {
  const resumeText = String(candidate?.resumeText || "");
  const dropped = [];
  if (!resumeText.trim()) {
    return { anchors: [], dropped: [{ reason: "no_resume_text" }], version: ANCHOR_SELECTION_VERSION };
  }

  const seen = new Set();
  const verified = [];
  candidateAnchors(candidate, job).forEach((anchor, order) => {
    const term = norm(anchor.term);
    const key = term.toLowerCase();
    if (!term || term.length < MIN_TERM_CHARS) {
      dropped.push({ term, reason: "term_too_short" });
      return;
    }
    if (seen.has(key)) {
      dropped.push({ term, reason: "duplicate_term" });
      return;
    }
    // CITE OR DROP. The structured field said this; the document has to agree. A term the
    // extractor produced that is nowhere in the résumé is exactly the hallucination this rule
    // exists for, and asking a candidate about it would be asking them to account for something
    // they never wrote.
    const span = locateQuote(resumeText, term);
    if (!span) {
      dropped.push({ term, reason: "not_in_resume_text" });
      return;
    }
    seen.add(key);
    verified.push({
      ...anchor,
      term,
      quote: windowAround(resumeText, term) || term,
      start: span.start,
      end: span.end,
      order,
      status: "pending",
    });
  });

  verified.sort((a, b) => b.weight - a.weight || a.order - b.order);
  const anchors = verified.slice(0, max).map((a, i) => ({
    id: `anchor-${i + 1}`,
    kind: a.kind,
    term: a.term,
    focus: a.focus || "",
    quote: a.quote,
    start: a.start,
    end: a.end,
    weight: a.weight,
    criterionId: criterionForAnchor(a, criteria),
    status: "pending",
  }));
  return { anchors, dropped, version: ANCHOR_SELECTION_VERSION };
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Does this question actually ask about this anchor?
 *
 * The same guarantee questionCoversProbe gives claim-probes, and needed for the same reason: the
 * model is asked to write a question about the anchor and told to stamp the anchor's id on it,
 * and nothing else would ever check that the two agree. An anchor marked covered by a question
 * that never mentioned it is a false coverage claim, which is worse than no coverage claim.
 *
 * Naming the term is the whole test. An anchor's only job is to guarantee the subject came up.
 */
function questionCoversAnchor(question, anchor) {
  if (!anchor) return false;
  return mentions(question, anchor.term) || (Boolean(anchor.focus) && mentions(question, anchor.focus));
}

/**
 * The line handed to the question prompt. Phrased as the SUBJECT to ask about, never as a
 * suggested question — an anchor carries no approved wording (unlike a probe, which was
 * neutrality-checked at generation), so the interviewer writes the question and
 * utils/questionVetting checks it like any other.
 */
function anchorBriefLine(anchor) {
  const where =
    anchor.kind.startsWith("project") ? "a project on their résumé"
      : anchor.kind.startsWith("experience") ? "an employer on their résumé"
        : "a skill claimed on their résumé";
  const focus = anchor.focus && anchor.focus.toLowerCase() !== anchor.term.toLowerCase()
    ? ` — specifically their use of ${anchor.focus}`
    : "";
  return `- anchorId "${anchor.id}": ${anchor.term} (${where}${focus}). Their résumé says: "${anchor.quote}"`;
}

module.exports = {
  ANCHOR_SELECTION_VERSION,
  MAX_ANCHORS,
  MIN_TERM_CHARS,
  WEIGHTS,
  mentions,
  windowAround,
  candidateAnchors,
  criterionForAnchor,
  selectAnchors,
  questionCoversAnchor,
  anchorBriefLine,
};
