// Ensemble agreement math (BUILD-PLAN Phase 2.1). Pure functions, no I/O.
//
// The engineering rule this enforces: agreement between N LLM samples is computed
// IN CODE by field-level comparison — never by asking a model whether its answers
// agree. Disagreement is a routing signal (rule 4): callers use `agreement` and
// `disagreements` to decide whether an output is trustworthy or needs a human.

// Local stable stringify (sorted keys) so two logically-equal values compare equal
// regardless of property order. Mirrors llmService.stableStringify; duplicated here
// because utils must not depend on services.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Field-level consensus over N sampled JSON outputs.
 *
 * For object samples, each top-level field is compared across samples by deep
 * equality; the modal value wins (ties break to the earliest sample, which keeps
 * the result deterministic). Non-object samples (arrays/scalars) are compared as
 * a single whole-value field named "$".
 *
 * Returns {
 *   consensus,        // modal value per field (assembled object, or whole value)
 *   agreement,        // mean over fields of (modal count / N), in [0, 1]
 *   fieldAgreement,   // { field -> modal count / N }
 *   disagreements,    // [{ field, values: [{ value, count }...] }] for split fields
 *   unanimous         // agreement === 1
 * }
 */
function computeConsensus(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("computeConsensus requires a non-empty samples array");
  }
  const n = samples.length;
  const allObjects = samples.every(isPlainObject);

  // Field name -> Map(canonicalJson -> { value, count, firstIndex })
  const fields = new Map();
  const addVote = (field, value, sampleIndex) => {
    const canon = stableStringify(value === undefined ? null : value);
    if (!fields.has(field)) fields.set(field, new Map());
    const votes = fields.get(field);
    if (!votes.has(canon)) votes.set(canon, { value, count: 0, firstIndex: sampleIndex });
    votes.get(canon).count += 1;
  };

  if (allObjects) {
    const keys = new Set();
    for (const s of samples) for (const k of Object.keys(s)) keys.add(k);
    for (const key of [...keys].sort()) {
      samples.forEach((s, i) => addVote(key, s[key], i));
    }
  } else {
    samples.forEach((s, i) => addVote("$", s, i));
  }

  const consensus = allObjects ? {} : undefined;
  let consensusWhole;
  const fieldAgreement = {};
  const disagreements = [];
  let agreementSum = 0;

  for (const [field, votes] of fields) {
    // Modal value; ties resolve to the variant seen in the earliest sample.
    let modal = null;
    for (const v of votes.values()) {
      if (!modal || v.count > modal.count || (v.count === modal.count && v.firstIndex < modal.firstIndex)) {
        modal = v;
      }
    }
    const ratio = modal.count / n;
    fieldAgreement[field] = ratio;
    agreementSum += ratio;
    if (allObjects) {
      if (modal.value !== undefined) consensus[field] = modal.value;
    } else {
      consensusWhole = modal.value;
    }
    if (votes.size > 1) {
      disagreements.push({
        field,
        values: [...votes.values()]
          .sort((a, b) => b.count - a.count || a.firstIndex - b.firstIndex)
          .map(({ value, count }) => ({ value, count })),
      });
    }
  }

  const agreement = fields.size ? agreementSum / fields.size : 1;
  return {
    consensus: allObjects ? consensus : consensusWhole,
    agreement,
    fieldAgreement,
    disagreements,
    unanimous: disagreements.length === 0,
  };
}

module.exports = { computeConsensus, stableStringify };
