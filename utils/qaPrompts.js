// Adversarial-critic prompts (BUILD-PLAN Phase 7.2). Pure builders. The
// critic's ONLY job is to refute: find claims whose quoted evidence does not
// actually support what the claim asserts. It is prompted to default to
// refuting when uncertain — a surviving claim has now been attacked twice
// (span verification in code, semantic support by an adversary).

const CRITIC_PROMPT_VERSION = "2026-07-25.1";

const CRITIC_SYSTEM =
  "You are an adversarial evidence auditor. You receive claims extracted from a résumé, each with the verbatim quote " +
  "it rests on. Your ONLY job is to refute: list every claim whose quote does not actually assert what the claim says " +
  "— overreach, misreading, topic-mention treated as ability, numbers not present in the quote. When you are unsure " +
  "whether a quote supports a claim, REFUTE it. You never confirm, praise, or score anything.";

const CRITIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    refuted: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claimId: { type: "string" },
          reason: { type: "string" },
        },
        required: ["claimId", "reason"],
      },
    },
  },
  required: ["refuted"],
};

function criticPrompt(claims) {
  const lines = claims.map((c) => {
    const statement = `${c.subject} ${c.predicate} ${c.object}`.trim();
    const quote = c.spans?.[0]?.quote || "";
    return `- id: ${c.id}\n  claim: ${statement}\n  quote: "${String(quote).slice(0, 300)}"`;
  });
  return (
    `CLAIMS WITH THEIR EVIDENCE:\n${lines.join("\n")}\n\n` +
    `List every claim id whose quote does not genuinely assert the claim. Default to refuting when uncertain. ` +
    `An empty list means every quote fully supports its claim. Return JSON.`
  );
}

module.exports = { CRITIC_PROMPT_VERSION, CRITIC_SYSTEM, CRITIC_SCHEMA, criticPrompt };
