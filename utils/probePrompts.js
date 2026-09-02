// Probe generation + verdict assessment prompts (BUILD-PLAN Phase 8).
//
// A probe is an interview question generated from ONE unverified high-weight
// claim, with the verification conditions precomputed at generation time
// (whatWouldVerify / whatWouldContradict) so the later verdict is checked
// against stated criteria rather than vibes.
//
// Neutrality is a hard guardrail, enforced in CODE (probePhrasingIssues): a
// probe says "walk me through how you built X", never "you claim you built X".
// An accusatory probe is a defect and is dropped, not asked.

const PROBE_PROMPT_VERSION = "2026-07-25.1";

const PROBE_SYSTEM =
  "You design interview questions that test specific resume claims. For each claim you receive, produce ONE " +
  "neutral, open-ended question a friendly senior interviewer would ask to let the candidate demonstrate the claimed " +
  "experience first-hand. NEVER phrase a question as an accusation, a challenge, or a request to prove anything — " +
  "never use wording like \"you claim\", \"prove\", \"is it true\", \"really\", or reference the resume itself. " +
  "Ask about the work: \"walk me through…\", \"tell me about…\", \"how did you…\". " +
  "For each question also state, concretely and checkably: what in an answer would VERIFY the claim (specific " +
  "details, mechanisms, trade-offs only someone who did it would know) and what would CONTRADICT it (inability to " +
  "describe basics, descriptions inconsistent with the claim). Return JSON only.";

const PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    probes: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claimId: { type: "string" },
          question: { type: "string" },
          whatWouldVerify: { type: "string" },
          whatWouldContradict: { type: "string" },
        },
        required: ["claimId", "question", "whatWouldVerify", "whatWouldContradict"],
      },
    },
  },
  required: ["probes"],
};

function claimStatement(claim) {
  return [claim.subject, claim.predicate, claim.object].filter(Boolean).join(" ").trim();
}

function probePrompt(claims) {
  const lines = claims.map((c) => {
    const quote = c.spans?.[0]?.quote || "";
    return `- claimId "${c.id}": ${claimStatement(c)}${quote ? ` (resume wording: "${quote}")` : ""}`;
  });
  return (
    `Resume claims to design one interview question each for:\n${lines.join("\n")}\n\n` +
    `For every claimId above return one probe: a neutral question plus its whatWouldVerify / whatWouldContradict ` +
    `conditions. Use only the claimIds listed. Return JSON.`
  );
}

// ---- Verdict assessment (after the interview) ----

const VERDICT_SYSTEM =
  "You are auditing whether interview answers bear out specific resume claims. For each item you receive a claim, " +
  "the question asked, the candidate's verbatim answer, and the precomputed conditions for verification and " +
  "contradiction. Judge ONLY against those stated conditions. Verdicts: \"verified\" (the answer meets the " +
  "whatWouldVerify condition), \"contradicted\" (the answer meets the whatWouldContradict condition), or " +
  "\"inconclusive\" (anything else — including a partial, evasive, or off-topic answer). When uncertain, choose " +
  "inconclusive. For verified or contradicted you MUST copy a short verbatim quote from the answer as evidence " +
  "(answerQuote); an empty or inexact quote makes the verdict invalid. You never make hiring judgements — only " +
  "claim-level verdicts. Return JSON only.";

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdicts: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claimId: { type: "string" },
          verdict: { type: "string", enum: ["verified", "contradicted", "inconclusive"] },
          reasoning: { type: "string" },
          answerQuote: { type: "string" },
        },
        required: ["claimId", "verdict", "reasoning", "answerQuote"],
      },
    },
  },
  required: ["verdicts"],
};

function verdictPrompt(items) {
  const blocks = items.map(
    (it) =>
      `claimId "${it.claimId}"\nCLAIM: ${it.statement}\nQUESTION ASKED: ${it.question}\n` +
      `WOULD VERIFY: ${it.whatWouldVerify}\nWOULD CONTRADICT: ${it.whatWouldContradict}\n` +
      `CANDIDATE ANSWER (verbatim):\n"""${it.answerText}"""`
  );
  return (
    `Assess each claim below against its candidate answer.\n\n${blocks.join("\n\n---\n\n")}\n\n` +
    `Return one verdict per claimId, judged strictly against the stated conditions. Return JSON.`
  );
}

// ---- Neutrality check (pure, code-enforced) ----
//
// Returns the list of accusatory patterns a probe question matches; a probe
// with any issue is DROPPED by the sanitiser. Kept deliberately tight: these
// phrasings frame the candidate as a suspect, which both biases the answer and
// is exactly the tone the guardrail bans.
const ACCUSATORY_PATTERNS = [
  { code: "you_claim", re: /\byou (?:claim|claimed|allege|alleged|assert|asserted)\b/i },
  { code: "prove", re: /\bprove\b/i },
  { code: "is_it_true", re: /\bis (?:it|that) (?:really |actually )?true\b/i },
  { code: "did_you_really", re: /\bdid you (?:really|actually|truly)\b/i },
  { code: "resume_reference", re: /\byour (?:resume|résumé|cv) (?:claims|says|states|asserts)\b/i },
  { code: "honesty_challenge", re: /\bbe honest\b|\bhonestly\b|\btruthfully\b|\badmit\b/i },
  { code: "doubt", re: /\bwe (?:doubt|don'?t believe|question whether)\b/i },
  { code: "verify_challenge", re: /\b(?:verify|confirm) that you\b/i },
];

function probePhrasingIssues(question) {
  const q = String(question || "");
  return ACCUSATORY_PATTERNS.filter((p) => p.re.test(q)).map((p) => p.code);
}

module.exports = {
  PROBE_PROMPT_VERSION,
  PROBE_SYSTEM,
  PROBE_SCHEMA,
  probePrompt,
  VERDICT_SYSTEM,
  VERDICT_SCHEMA,
  verdictPrompt,
  probePhrasingIssues,
  claimStatement,
};
