// Prompt + schema for compiling a job's must-ask interview questions. Pure — questionSetService
// consumes these via llmService.
//
// The model proposes QUESTION TEXT and nothing else. No weights, no scores, no ordering
// importance, no numbers of any kind — the same rule the rubric compiler follows, for the same
// reason: a model-authored figure must never be able to leak into a candidate's result. What a
// question is WORTH stays with the versioned rubric; this only decides what gets asked.
//
// Every proposed question is then vetted in code (utils/questionVetting) and anything that
// touches a protected characteristic or reads as an accusation is DROPPED, not fixed. That is
// the important half: the model is an unreliable source of legally-sensitive text, so nothing it
// produces reaches a candidate without passing a deterministic gate first.

const { SECURITY_SENTENCE, fenceUntrusted } = require("./promptSafety");

// Bump on any wording change: promptVersion is part of the LLM cache key and is persisted on
// every set this prompt compiles (reproducibility / audit).
const QUESTION_SET_PROMPT_VERSION = "2026-08-03.1";

const QUESTION_SET_SYSTEM =
  "You design the core question set for a structured job interview. Every candidate for this role will be " +
  "asked your questions, word for word, in the order you give them — so they must be fair, answerable by anyone " +
  "who has genuinely done this work, and free of anything specific to one person's résumé. " +
  "Write questions that invite someone to describe real work: \"walk me through…\", \"tell me about a time…\", " +
  "\"how did you…\". Never ask a candidate to prove, justify or defend anything, and never reference a résumé. " +
  "NEVER ask about age, family, marital status, children, pregnancy, religion, caste, race, ethnicity, national " +
  "origin, immigration or visa status, health, disability, gender, sexual orientation, salary history, criminal " +
  "record or political views — these are unlawful to ask and will be discarded. " +
  "Each question must be one sentence a person can hold in their head when they hear it spoken aloud. " +
  SECURITY_SENTENCE;

const QUESTION_SET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    questions: {
      type: "array",
      maxItems: 12,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          // Which rubric criterion this question is meant to give evidence for, by id, or "" if
          // it is a general anchor. Recorded so a recruiter can see the set's coverage of the
          // criteria — never used as a weight or a score.
          criterionId: { type: "string" },
          topic: { type: "string" },
        },
        required: ["text", "criterionId", "topic"],
      },
    },
  },
  required: ["questions"],
};

// The rubric's criteria are the thing worth covering — they are what the role was decomposed
// into and what the candidate is ultimately scored against. Passing them in is what stops the
// set being eight generic questions that could belong to any job.
function criteriaBlock(criteria) {
  if (!Array.isArray(criteria) || !criteria.length) return "";
  const lines = criteria
    .filter((c) => c.kind !== "disqualifier")
    .map((c) => `- id="${c.id}" [${c.kind}] ${c.label}${c.rationale ? `: ${c.rationale}` : ""}`);
  if (!lines.length) return "";
  return (
    `APPROVED HIRING CRITERIA for this role — the set should let a candidate give evidence for the ` +
    `most important of these. Set "criterionId" to the id a question targets, or "" for a general ` +
    `anchor question:\n${lines.join("\n")}\n\n`
  );
}

function questionSetPrompt({ sourceText, criteria, count }) {
  return (
    `Design the must-ask interview question set for the role below.\n\n` +
    `<job_description>\n${fenceUntrusted(sourceText)}\n</job_description>\n\n` +
    criteriaBlock(criteria) +
    `Produce ${count} questions.\n` +
    `- Order them so the interview opens broad and gets more specific.\n` +
    `- Cover the must-have criteria first; do not spend two questions on the same one.\n` +
    `- Each question must stand alone, spoken aloud, with no reference to any particular candidate.\n` +
    `- Do not ask anything a candidate could answer with yes or no.\n` +
    `Return JSON.`
  );
}

module.exports = {
  QUESTION_SET_PROMPT_VERSION,
  QUESTION_SET_SYSTEM,
  QUESTION_SET_SCHEMA,
  questionSetPrompt,
  criteriaBlock,
};
