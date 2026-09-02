// Keyterm (hotword) vocabulary for streaming speech-to-text.
//
// The ASR error class that actually damages a technical interview is not general word
// accuracy — it is mangled technical nouns. A general model hears "Kubernetes" as
// "cooper netties", "PostgreSQL" as "post gray sequel", "Kafka" as "coffee". Those are
// exactly the words the evaluator later reads as evidence, so a transcription miss becomes
// an EVIDENCE miss and the candidate is judged on a sentence they never said. Fixing that
// does not need a better speech model; it needs the vocabulary — and we already hold it:
// the role's requiredSkills (rubric-side, human-approved) and the candidate's own extracted
// skill claims (already span-verified in the ClaimGraph).
//
// Fairness — why this is not per-candidate favouritism:
//   - Role terms are IDENTICAL for every candidate for that job, so the shared vocabulary is
//     equal treatment by construction, and it is listed first so a truncated list keeps it.
//   - Candidate terms only make that candidate's own words transcribe as spoken. They add no
//     vocabulary the candidate did not themselves put in writing, and they cannot invent
//     content — biasing raises recognition of a word, it does not insert it.
//   - The exact list used is recorded on the session (services/asrVocabularyService), so a
//     disputed transcript is reconstructible rather than arguable.
//
// Deliberate exclusions:
//   - Only `skill` and `certification` claims. For those two types the claim text is
//     technical by construction (a skill or a certification name); `experience`,
//     `employment_period`, `education` and `project` claims carry employer, school and
//     person names, and keyterms travel to a third-party speech provider. Technical
//     vocabulary only.
//   - No LLM anywhere in this file. It is string handling over data we already store, so it
//     is reproducible run-to-run and cannot hallucinate a term into a candidate's transcript.

// Conservative caps. Providers bound both the number of keyterms and the request size, and
// the terms ride in the streaming URL's query string — verify against the provider's current
// limits before raising these.
const MAX_TERMS = 50;
const MAX_TERM_CHARS = 40;
// 2, not 1: biasing on a single letter is noise, not vocabulary. This deliberately drops the
// one-character language names ("R", "C") — the cost of missing those is far lower than
// pinning recognition to every stray letter in an answer.
const MIN_TERM_CHARS = 2;

// Résumé-derived strings reach this function, so treat them as hostile (CLAUDE.md rule 7):
// only characters that can plausibly spell a technical term survive. The allowed punctuation
// is the set real technology names need — "Node.js", "C++", "C#", "CI/CD", "ASP.NET",
// "scikit-learn", "A&B". Anything else (control characters, quotes, brackets, newlines,
// injected instruction text) is dropped rather than escaped, because a mangled keyterm has no
// value worth rescuing.
const SAFE_TERM = /^[A-Za-z0-9][A-Za-z0-9 .+#\-/_&']*$/;

function clean(raw) {
  const term = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
  if (term.length < MIN_TERM_CHARS || term.length > MAX_TERM_CHARS) return "";
  if (!SAFE_TERM.test(term)) return "";
  return term;
}

// Claim types whose text is technical vocabulary rather than somebody's name. See header.
const VOCAB_CLAIM_TYPES = new Set(["skill", "certification"]);

// Build the STT keyterm list for one candidate/role pairing. Pure and order-stable: the same
// job + claim graph always produce the same list, which is what makes the recorded audit row
// meaningful.
function buildKeyterms({ job, claimGraph, candidateName, limit = MAX_TERMS } = {}) {
  const out = [];
  const seen = new Set();

  const push = (raw) => {
    if (out.length >= limit) return;
    const term = clean(raw);
    if (!term) return;
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(term);
  };

  // The candidate's OWN name, very first — a deliberate, narrow exception to "technical
  // vocabulary only". The exclusion above keeps THIRD-PARTY names (employers, schools) away
  // from the speech provider; the candidate's own name adds no disclosure the audio itself
  // does not already make, and it is the proper noun the interview speaks most: the greeting,
  // the warmup ("Hi, I'm …"), the name check. On 2026-08-18 an unbiased transcript recorded a
  // candidate's self-introduction under the wrong name, which is the kind of error a reviewer
  // reads as evidence. Two terms at most (full name + first name), so the role vocabulary
  // still dominates the cap.
  // Gate BOTH pushes on the full name surviving clean(): a hostile or overlong string must not
  // leak even its first word into the vocabulary.
  const fullName = String(candidateName || "").replace(/\s+/g, " ").trim();
  if (fullName && clean(fullName)) {
    push(fullName);
    push(fullName.split(" ")[0]);
  }

  // Role vocabulary next — if the cap truncates, what survives is the list every candidate
  // for this job shares.
  for (const skill of job?.requiredSkills || []) push(skill);

  // Then the candidate's own span-verified claims. Canonical form AND surface form, because
  // candidates say both out loud ("Postgres" and "PostgreSQL"); `subject` covers claims whose
  // normalisation found no ontology match, which is most certifications.
  for (const claim of claimGraph?.claims || []) {
    if (!VOCAB_CLAIM_TYPES.has(claim?.type)) continue;
    push(claim?.normalized?.skill);
    push(claim?.normalized?.rawSkill);
    push(claim?.subject);
  }

  return out;
}

module.exports = { buildKeyterms, MAX_TERMS, MAX_TERM_CHARS, MIN_TERM_CHARS };
