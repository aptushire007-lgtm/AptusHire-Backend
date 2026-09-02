// Evidence-matching prompts + schema (BUILD-PLAN Phase 6.1). Pure builders.
//
// The matcher's ONLY job: per rubric criterion, does the verified claim set
// satisfy it, and which claims support that verdict. It returns statuses and
// claim ids — never a number that reaches the score (the deterministic scorer
// owns all arithmetic). Weights are deliberately withheld: how much a
// criterion matters must not colour whether the evidence satisfies it.

const MATCH_PROMPT_VERSION = "2026-07-25.1";

const MATCH_SYSTEM =
  "You are a precise evidence auditor. For each criterion you receive, decide whether the candidate's VERIFIED claims " +
  "satisfy it. You may only cite claims by their ids — every verdict except 'absent' MUST list the claim ids it rests " +
  "on, and verdicts with no supporting claims are discarded. Do not infer beyond the claims, do not reward confident " +
  "wording, do not consider anything about the person. If the evidence is genuinely unclear, say 'partial' or 'absent' " +
  "— uncertainty is a valid answer. You never output an overall judgement, score, or recommendation.";

const MATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          criterionId: { type: "string" },
          status: { type: "string", enum: ["satisfied", "partial", "absent", "contradicted"] },
          supportingClaimIds: { type: "array", items: { type: "string" } },
          reasoning: { type: "string" },
          confidence: { type: "number" }, // 0-1, routing signal only — never touches the score
        },
        required: ["criterionId", "status", "supportingClaimIds", "reasoning", "confidence"],
      },
    },
  },
  required: ["findings"],
};

function describeCriterion(c) {
  const lines = [
    `- id: ${c.id}`,
    `  requirement: ${c.label}`,
    `  kind: ${c.kind}${c.kind === "disqualifier" ? "  (this describes a DISQUALIFYING condition — 'satisfied' means the condition IS met)" : ""}`,
  ];
  if (c.acceptableEvidence?.length) lines.push(`  acceptable evidence: ${c.acceptableEvidence.join("; ")}`);
  if (c.seniorityFloor) lines.push(`  seniority floor: ${c.seniorityFloor}`);
  return lines.join("\n");
}

function describeClaim(c) {
  const bits = [
    `- id: ${c.id} [${c.type}] ${c.subject} ${c.predicate} ${c.object}`.trim(),
  ];
  const n = c.normalized || {};
  const norm = [
    n.skill ? `skill=${n.skill}` : "",
    n.years ? `years=${n.years}` : "",
    n.level ? `level=${n.level}` : "",
    n.startDate ? `period=${n.startDate}..${n.endDate || "present"}` : "",
  ].filter(Boolean);
  if (norm.length) bits.push(`  (${norm.join(", ")})`);
  bits.push(`  specificity=${c.specificity}, verification=${c.verificationStatus}`);
  const quote = c.spans?.[0]?.quote;
  if (quote) bits.push(`  quote: "${String(quote).slice(0, 200)}"`);
  return bits.join("\n");
}

function matchPrompt({ criteria, claims }) {
  return (
    `CRITERIA (return one finding per criterion id):\n${criteria.map(describeCriterion).join("\n")}\n\n` +
    `VERIFIED CLAIMS (the only admissible evidence):\n${claims.map(describeClaim).join("\n")}\n\n` +
    `For every criterion: status = satisfied | partial | absent | contradicted, with the supporting claim ids.\n` +
    `"contradicted" means a claim actively conflicts with the requirement — cite the conflicting claims.\n` +
    `An empty claim list, or claims that merely name a topic without asserting ability, is "absent".\n` +
    `Return JSON.`
  );
}

module.exports = { MATCH_PROMPT_VERSION, MATCH_SYSTEM, MATCH_SCHEMA, matchPrompt };
