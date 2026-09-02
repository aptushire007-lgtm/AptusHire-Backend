// Pure prompt + JSON-schema builders for the AI Interview Engine (Module 9).
// No SDK/DB here — llmService consumes these. The system prompt frames Claude
// as an experienced human technical interviewer, not a chatbot.

// Bump when the prompt wording changes so stored AI decisions record which prompt
// produced them (reproducibility / auditability — W4).
// 2026-07-25.2: Phase 8 — claim-probes as required coverage, probeId in the
// question schema, and honest closing semantics (isClosing is now read by code).
// 2026-08-03.1: recruiter-approved must-ask questions. They are delivered verbatim
// by code, so the model is told what is coming purely so it does not pre-empt or
// paraphrase one, and closing is additionally gated on all of them having been asked.
// 2026-08-17.1: the question path's system prompt no longer asserts that the interview
// is technical (interviewerSystemFor) — the job description defines the domain. Also
// tells the model that a grounded follow-up on the last answer is composed separately,
// so it does not spend its one question re-asking what the reflect step just covered.
// 2026-08-18.1: résumé anchors as required coverage (anchorBlock + anchorId in the schema), a
// regeneration notice when utils/questionSimilarity catches a repeat, and the difficulty rung is
// now computed by code (utils/difficultyLadder) and stated to the model rather than chosen by it.
const PROMPT_VERSION = "2026-08-18.1";

// The fence + security preamble are shared with the résumé pipeline via
// promptSafety (Phase 4.3). SECURITY_SENTENCE is byte-identical to the string
// previously inlined here, so this prompt's bytes — and therefore its replay
// fixtures and PROMPT_VERSION — are unchanged.
const { SECURITY_SENTENCE, fenceUntrusted } = require("./promptSafety");
const difficultyLadder = require("./difficultyLadder");

// Kept for the bias-blinded scoring prompts, which are domain-neutral already and whose stored
// decisions reference this exact wording. New callers want interviewerSystemFor() below.
const INTERVIEWER_SYSTEM =
  "You are an experienced senior technical interviewer conducting a live, voice-style interview. " +
  "Behave like a real human interviewer, not a chatbot: ask one focused question at a time, listen to the full answer, " +
  "probe with natural follow-ups, adapt difficulty to the candidate's demonstrated level, and never repeat a question. " +
  "Keep each spoken turn concise (1-3 sentences). Base every question on the job description, the resume, and what the " +
  "candidate has said so far. Judge answers on correctness, depth, and practical understanding — not keyword matching. " +
  SECURITY_SENTENCE;

// The question-generation system prompt, with the role's domain taken from the job description
// instead of asserted by the prompt.
//
// The string above opens "an experienced senior TECHNICAL interviewer", which is simply the wrong
// interviewer for a marketing, finance, operations or clinical role — and it goes wrong exactly
// where it does the most damage, with the model reaching for engineering competencies no rubric
// asked for and interrogating a content strategist about system design. See
// utils/followUpPrompts.interviewerSystemFor for why the fix is to stop asserting a domain rather
// than to classify the job into one.
function interviewerSystemFor(job) {
  return require("./followUpPrompts").interviewerSystemFor(job, {
    securitySentence: SECURITY_SENTENCE,
  });
}

function truncate(str, max) {
  const s = String(str || "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// Compact, token-bounded briefing assembled from the candidate + job records.
// Untrusted candidate-supplied text is fenced in <candidate_data> tags (prompt-injection
// defense — W4). `blind` omits the candidate's name so the evaluation prompt can't be
// influenced by a name-based proxy for a protected class (bias mitigation).
function buildContext(candidate, job, { blind = false } = {}) {
  const b = candidate.basicDetails || {};
  const skills = (candidate.skills || []).join(", ");
  const experience = (candidate.experience || [])
    .map((e) => `${e.role || ""} @ ${e.company || ""} (${e.startDate || "?"}–${e.currentlyWorking ? "present" : e.endDate || "?"})`)
    .join("; ");
  const education = (candidate.education || [])
    .map((e) => `${e.degree || ""}${e.fieldOfStudy ? " in " + e.fieldOfStudy : ""} — ${e.institution || ""}`)
    .join("; ");
  const projects = (candidate.projects || [])
    .map((p) => `${p.title || ""}${p.techStack ? " [" + p.techStack + "]" : ""}: ${truncate(p.description, 160)}`)
    .join("\n");
  const ats = candidate.ats || {};

  const jobBlock = [
    `JOB TITLE: ${job.title}`,
    job.department ? `DEPARTMENT: ${job.department}` : "",
    `JOB DESCRIPTION:\n${truncate(job.description, 1200)}`,
    job.requirements ? `REQUIREMENTS:\n${truncate(job.requirements, 800)}` : "",
    job.requiredSkills?.length ? `REQUIRED SKILLS: ${job.requiredSkills.join(", ")}` : "",
    `MIN EXPERIENCE: ${job.minExperienceYears || 0} years`,
  ]
    .filter(Boolean)
    .join("\n");

  const candidateBlock = [
    blind ? "" : `CANDIDATE NAME: ${b.name}`,
    skills ? `CANDIDATE SKILLS: ${skills}` : "",
    experience ? `EXPERIENCE: ${experience}` : "",
    education ? `EDUCATION: ${education}` : "",
    projects ? `PROJECTS:\n${projects}` : "",
    ats.overallScore != null ? `ATS SCORE: ${ats.overallScore} (missing: ${(ats.missingSkills || []).join(", ") || "none"})` : "",
    // §3.2: 1500 chars (~250 words) cut most résumés off after the first role, which is the
    // literal cause of "not asking questions from the résumé" — the last two roles were outside
    // the window. 6000 chars (~1000 words) covers the large majority of one-to-two-page résumés in
    // full. Not doing full section-aware reselection here on purpose: that would mean fetching
    // Resume.autofill mid-prompt-build, adding a DB round-trip to the same path §3.3 just bounded
    // for latency — a bigger raw budget gets most of the benefit without fighting that fix.
    candidate.resumeText ? `RESUME TEXT (excerpt):\n${truncate(candidate.resumeText, 6000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return [jobBlock, "---", fenceUntrusted(candidateBlock)].join("\n");
}

// ---- Interview plan ----
const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    role: { type: "string" },
    difficultyEstimate: { type: "string", enum: ["easy", "medium", "hard"] },
    topics: { type: "array", items: { type: "string" } },
    focusAreas: { type: "array", items: { type: "string" } },
    summary: { type: "string" },
  },
  required: ["role", "difficultyEstimate", "topics", "focusAreas", "summary"],
};

function planPrompt(context) {
  return (
    `Read the job and candidate below and produce an interview plan.\n\n${context}\n\n` +
    `Estimate an appropriate starting difficulty for this role and seniority, list the question topics to cover ` +
    `(drawn from the job description and the candidate's actual skills/projects), and the areas to probe most. ` +
    `Return the plan as JSON.`
  );
}

// ---- Next question ----
const QUESTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answerScore: { type: "integer" }, // 0-100 for the PREVIOUS answer; use 0 when there is none yet
    difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
    topic: { type: "string" },
    question: { type: "string" },
    // Which required-coverage probe this question addresses ("" when none) — Phase 8.2.
    probeId: { type: "string" },
    // Which résumé anchor this question addresses ("" when none) — utils/resumeAnchors. Verified
    // in code against the question text before the anchor is marked asked, exactly as probeId is:
    // a stamped id that the question does not actually ask about is a false coverage claim.
    anchorId: { type: "string" },
    isClosing: { type: "boolean" },
  },
  required: ["answerScore", "difficulty", "topic", "question", "probeId", "anchorId", "isClosing"],
};

function transcriptText(turns) {
  return turns
    .map((t) => `${t.role === "ai" ? "INTERVIEWER" : "CANDIDATE"}: ${t.text}`)
    .join("\n");
}

// §3.3: transcriptText(turns) with NO window, embedded in full on every single next-question call,
// is what made prompt size (and cost/latency) grow with turn count — turn 20 shipped 20 turns of
// context. One line per older turn, deterministic and code-built (never a model call — an LLM
// summarization round-trip here would fight the latency fix this exists for), keeps the prompt
// roughly flat past `windowSize` while the model still sees the most recent exchanges verbatim,
// which is all it actually needs (it only ever scores the LATEST candidate answer).
function turnDigestLine(t) {
  const text = String(t.text || "");
  const excerpt = text.length > 80 ? `${text.slice(0, 80)}…` : text;
  if (t.role === "ai") return `- interviewer asked: "${excerpt}"`;
  const scoreNote = typeof t.answerScore === "number" ? ` (scored ${t.answerScore}/100)` : "";
  return `- candidate answered: "${excerpt}"${scoreNote}`;
}

function recentTranscriptWithSummary(turns, { windowSize = 8 } = {}) {
  const list = Array.isArray(turns) ? turns : [];
  if (list.length <= windowSize) return transcriptText(list);

  const older = list.slice(0, list.length - windowSize);
  const recent = list.slice(list.length - windowSize);
  return (
    `EARLIER IN THIS INTERVIEW (condensed):\n${older.map(turnDigestLine).join("\n")}\n\n` +
    `MOST RECENT EXCHANGES (verbatim):\n${transcriptText(recent)}`
  );
}

// Required-coverage block (Phase 8.2): uncovered claim-probes the interview
// MUST ask before it can end. Phrasing arrives pre-checked for neutrality.
function probeBlock(probes) {
  if (!Array.isArray(probes) || probes.length === 0) return "";
  const lines = probes.map((p) => `- probeId "${p.claimId}": ${p.question}`);
  return (
    `REQUIRED COVERAGE — each of these topics must be asked before the interview can end. When you ask one ` +
    `(use the suggested wording or a natural, equally neutral variant), set "probeId" to its id; otherwise set probeId="":\n` +
    `${lines.join("\n")}\n\n`
  );
}

// Recruiter-approved questions still to come. The model is told about them so it does NOT
// pre-empt or paraphrase one — they are delivered verbatim by code (aiInterviewService), and a
// model that asked its own version first would leave the approved one arriving as a duplicate.
function mustAskBlock(mustAsk) {
  if (!Array.isArray(mustAsk) || mustAsk.length === 0) return "";
  const lines = mustAsk.map((q) => `- ${q.text}`);
  return (
    `RECRUITER-APPROVED QUESTIONS STILL TO COME — these will be asked automatically, word for ` +
    `word, and are NOT yours to ask. Do not ask them, do not rephrase them, and do not ask ` +
    `anything that would make them redundant. Your job is to follow up on what the candidate ` +
    `actually said:\n${lines.join("\n")}\n\n`
  );
}

// The regeneration notice, used only on the second attempt after utils/questionSimilarity caught
// the first one as a repeat. It names the offending pair rather than restating the generic "never
// repeat" rule — which is the rule that had just been ignored, so restating it is the one thing
// known not to work.
function repeatBlock(rejected) {
  if (!rejected) return "";
  return (
    `YOUR PREVIOUS ATTEMPT WAS REJECTED. You proposed:\n  "${rejected.question}"\n` +
    `That is the same subject as a question already asked:\n  "${rejected.matched}"\n` +
    `Ask about a DIFFERENT subject entirely — not a rewording, not a narrower version, not the same ` +
    `topic from another angle. Pick something from the plan or their background that has not come up ` +
    `at all yet.\n\n`
  );
}

// Résumé topics this interview must cover (utils/resumeAnchors). Unlike a claim-probe, an anchor
// carries NO approved wording — it names a subject and quotes the document, and the interviewer
// writes the question, which then passes utils/questionVetting like any other. That difference is
// deliberate: a probe's phrasing was neutrality-checked when it was generated, an anchor's has
// not been, so the anchor cannot be allowed to put words in the interviewer's mouth.
function anchorBlock(anchors) {
  if (!Array.isArray(anchors) || anchors.length === 0) return "";
  const { anchorBriefLine } = require("./resumeAnchors");
  return (
    `THE CANDIDATE'S RÉSUMÉ — TOPICS THIS INTERVIEW MUST COVER. Each of these is something the ` +
    `candidate wrote on their own résumé that this job cares about. Ask about one directly, in your ` +
    `own words, and set "anchorId" to its id (otherwise set anchorId=""). Your question MUST name ` +
    `the topic. Ask what they actually did with it — what they built, what decision they made, what ` +
    `went wrong — never whether they "have experience with" it, which invites a yes:\n` +
    `${anchors.map(anchorBriefLine).join("\n")}\n\n`
  );
}

function questionPrompt({ context, plan, turns, currentDifficulty, askedQuestions, questionCount, minQuestions, maxQuestions, probes, mustAsk, anchors, rejected }) {
  const remaining = maxQuestions - questionCount;
  const uncovered = (probes || []).length + (anchors || []).length;
  const unasked = (mustAsk || []).length;
  const mustCoverNow = uncovered > 0 && remaining <= uncovered + unasked;
  // An approved question that has not been asked yet means the interview has not run the
  // instrument the recruiter approved, so it cannot close — same gate as an uncovered probe.
  const canClose = uncovered === 0 && unasked === 0 && questionCount >= (minQuestions || 1);
  return (
    `${context}\n\n` +
    `INTERVIEW PLAN: topics=${(plan.topics || []).join(", ")}; focus=${(plan.focusAreas || []).join(", ")}.\n\n` +
    mustAskBlock(mustAsk) +
    probeBlock(probes) +
    anchorBlock(anchors) +
    repeatBlock(rejected) +
    `CONVERSATION SO FAR:\n${recentTranscriptWithSummary(turns) || "(none yet — this is the opening)"}\n\n` +
    `ALREADY ASKED (never repeat these):\n${(askedQuestions || []).map((q) => "- " + q).join("\n") || "(none)"}\n\n` +
    `${difficultyLadder.briefFor(currentDifficulty)} Questions asked: ${questionCount}/${maxQuestions}.\n\n` +
    `Instructions: First, score the candidate's most recent answer 0-100 in "answerScore" (use 0 if there is no answer yet). ` +
    // The model used to be told to "decide the next difficulty", and its answer became the stored
    // rung — a value whose only consumer was the next copy of this same prompt. The rung is now
    // computed in code from the scores below (utils/difficultyLadder), so what is asked for here
    // is a LABEL for the question being written, not a decision about the interview.
    `Set "difficulty" to the level of the question you are about to ask. The difficulty stated ` +
    `above was set by the system from the scores you have already given — pitch your question at ` +
    `it rather than choosing your own level. ` +
    `If they said they don't know, move to a different topic. Ask ONE new question grounded in their resume/projects and the ` +
    `job — prefer a natural follow-up to what they just said. Never repeat an already-asked question. ` +
    (mustCoverNow ? `Only ${remaining} question(s) remain and ${uncovered} required topic(s) are uncovered — cover a required topic NOW. ` : ``) +
    (canClose
      ? `All required topics are covered. If the interview has naturally reached its end, you may close: set isClosing=true and make "question" a brief, warm closing statement (no new question). Otherwise set isClosing=false and continue. `
      : `Set isClosing=false. `) +
    `Return JSON.`
  );
}

// ---- Late answer scoring (Phase 9.1) ----
// The hard-stop path completes the interview without a next-question call, so
// the final answer historically was NEVER scored. Finalisation scores any
// unscored answer through this dedicated, bias-blinded prompt.
const ANSWER_SCORE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answerScore: { type: "integer" }, // 0-100
  },
  required: ["answerScore"],
};

// ---- Spoken communication (utils/communication.js) ----
//
// The model OBSERVES; code scores. Every field is a yes/no with the quote that evidences it, and
// an observation that cannot be quoted is dropped rather than trusted.
//
// Note what this prompt refuses to ask for. Not "rate their communication out of ten" — that
// returns the model's overall impression of the candidate wearing a number. Not anything about
// how they SOUNDED: pace, hesitation and filler words never reach the model, because they are not
// in the transcript, which is exactly why this can be assessed at all.
const COMMUNICATION_SYSTEM =
  "You observe how clearly a candidate explained something, from a transcript of what they said. " +
  "You never judge whether the answer was technically correct — that is assessed separately and " +
  "is not your concern. You never comment on the person. You report only what you can quote.";

function communicationPrompt({ question, answer }) {
  return (
    `QUESTION THEY WERE ASKED:\n${question}\n\n` +
    `WHAT THEY SAID (a transcript of speech — expect no punctuation to be reliable, and expect ` +
    `false starts and repetition, which are normal in speech and are NOT communication problems):\n` +
    `${fenceUntrusted(answer)}\n\n` +
    `For each field, answer true or false and give a SHORT VERBATIM QUOTE from the transcript that ` +
    `shows it. If a field is false, leave the quote empty. If you cannot find a real quote, answer ` +
    `false rather than inventing one.\n\n` +
    `- answersTheQuestion — did they address what was actually asked, rather than something near it?\n` +
    `- hasConcreteExample — did they give a specific instance (a system, a number, a decision, a ` +
    `moment) rather than describing how one generally does this kind of work?\n` +
    `- termsAreExplained — is the jargon they introduced explained, or did none need explaining? ` +
    `Precise technical language used precisely is GOOD communication — do not mark it down for ` +
    `being technical.\n` +
    `- referencesAreResolvable — could a listener who was not there follow it? False only when ` +
    `"it", "they" or "that" is left with no antecedent a reader could recover.\n` +
    `- statedUncertaintyWhereItExisted — did they mark the boundary of what they knew ("I'm not ` +
    `certain of the exact figure, but…")? This is a STRENGTH. If there was nothing they were ` +
    `unsure about, answer false — it is simply not evidence either way.\n` +
    `- overclaimed — did they assert specifics the rest of the answer gives no basis for, or ` +
    `contradict something they said earlier? Ordinary hedging is NOT overclaiming.\n` +
    `- ownContributionIsClear — is it clear what THEY did, as opposed to what their team did?\n\n` +
    `Return JSON.`
  );
}

function answerScorePrompt({ context, question, answer }) {
  return (
    `${context}\n\n` +
    `QUESTION ASKED:\n${question}\n\n` +
    `CANDIDATE ANSWER:\n${answer}\n\n` +
    `Score this single answer 0-100 for correctness, depth, and practical understanding, exactly as you would have ` +
    `scored it during the interview. Judge only what the answer demonstrates. Return JSON.`
  );
}

// ---- Final evaluation ----
// The four numbers are bounded HERE as well as checked in code, because these are the only
// model-supplied integers in the system that reach a hiring decision unmediated: overallScore is
// what interviewReportEngine.computeVerdict thresholds into ADVANCE / CLEAR_REJECT. Bounds in the
// schema stop most of it at the provider; aiInterviewService.makeEvaluation rejects the rest,
// because `strict` structured output constrains the SHAPE and no provider guarantees the range.
const EVALUATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    overallScore: { type: "integer", minimum: 0, maximum: 100 },
    communication: { type: "integer", minimum: 0, maximum: 100 },
    technicalKnowledge: { type: "integer", minimum: 0, maximum: 100 },
    problemSolving: { type: "integer", minimum: 0, maximum: 100 },
    strengths: { type: "array", items: { type: "string" } },
    weaknesses: { type: "array", items: { type: "string" } },
    missingSkills: { type: "array", items: { type: "string" } },
    recommendation: { type: "string", enum: ["strong_hire", "hire", "maybe", "no_hire"] },
    summary: { type: "string" },
  },
  required: [
    "overallScore",
    "communication",
    "technicalKnowledge",
    "problemSolving",
    "strengths",
    "weaknesses",
    "missingSkills",
    "recommendation",
    "summary",
  ],
};

function evaluationPrompt({ context, turns }) {
  return (
    `${context}\n\n` +
    `FULL INTERVIEW TRANSCRIPT:\n${transcriptText(turns)}\n\n` +
    `Evaluate this candidate for the role. Score communication, technical knowledge, and problem solving 0-100, ` +
    `give an overall score 0-100, list concrete strengths and weaknesses, list any required skills that appeared weak or missing, ` +
    `and give a hiring recommendation. Base every judgement STRICTLY on the competencies the candidate demonstrated in the ` +
    `transcript. Do NOT consider or infer name, gender, age, ethnicity, nationality, or any other protected characteristic — ` +
    `assess job-relevant ability only. Return JSON.`
  );
}

module.exports = {
  repeatBlock,
  anchorBlock,
  transcriptText,
  recentTranscriptWithSummary,
  PROMPT_VERSION,
  INTERVIEWER_SYSTEM,
  interviewerSystemFor,
  buildContext,
  PLAN_SCHEMA,
  planPrompt,
  QUESTION_SCHEMA,
  questionPrompt,
  ANSWER_SCORE_SCHEMA,
  answerScorePrompt,
  EVALUATION_SCHEMA,
  evaluationPrompt,
  COMMUNICATION_SYSTEM,
  communicationPrompt,
};
