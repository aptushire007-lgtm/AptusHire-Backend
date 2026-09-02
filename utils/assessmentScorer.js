// Deterministic assessment scorer (ASSESSMENT-ENGINE-PLAN A2.6). PURE: no I/O,
// no clock, no model. (frozen paper × assembled items × responses) → score.
//
// Engineering rule 1 made literal: the answer keys were pre-committed at freeze
// time; correctness is set arithmetic; the model never emits a number anywhere
// in this file. reproducibilityHash asserts it: same inputs ⇒ same hash ⇒ same
// score, months later, in CI, in a discrimination claim.

const crypto = require("crypto");

const SCORER_VERSION = "assess-scorer-2026-07-30.1";

function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

function stableStringify(value) {
  if (value === null || value === undefined || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function asIdArray(response) {
  if (!Array.isArray(response)) return null;
  const ids = response.filter((v) => typeof v === "string" && v.trim());
  return ids.length ? ids : null;
}

function isAnswered(type, response) {
  if (response === null || response === undefined) return false;
  if (type === "numeric") return Number.isFinite(Number(response));
  const ids = asIdArray(response);
  return Boolean(ids);
}

/**
 * Key-match for one item. Returns true only for a fully correct answer:
 * mcq_multi is exact set equality (no partial credit in v1 — partial credit is
 * a scoring-policy decision a human should make, not a default).
 */
function isCorrect(item, response) {
  if (!isAnswered(item.type, response)) return false;
  const key = item.key || {};
  switch (item.type) {
    case "mcq_single": {
      const ids = asIdArray(response);
      return Boolean(ids && ids.length === 1 && Array.isArray(key.optionIds) && key.optionIds.length === 1 && ids[0] === key.optionIds[0]);
    }
    case "mcq_multi": {
      const ids = asIdArray(response);
      if (!ids || !Array.isArray(key.optionIds)) return false;
      const a = new Set(ids);
      const b = new Set(key.optionIds);
      if (a.size !== b.size) return false;
      for (const id of a) if (!b.has(id)) return false;
      return true;
    }
    case "numeric": {
      const value = Number(response);
      if (!Number.isFinite(value) || !Number.isFinite(key.value)) return false;
      const tolerance = Number.isFinite(key.tolerance) ? Math.abs(key.tolerance) : 0;
      return Math.abs(value - key.value) <= tolerance;
    }
    case "ordering": {
      const ids = asIdArray(response);
      if (!ids || !Array.isArray(key.order) || ids.length !== key.order.length) return false;
      return ids.every((id, i) => id === key.order[i]);
    }
    default:
      return false;
  }
}

/**
 * Score one session's work against its frozen paper.
 *
 * @param {object} paper           AssessmentPaper (or plain object) — items with keys
 * @param {Array}  assembledItems  [{ itemId, sectionId, targetsClaimId }]
 * @param {Array}  responses       [{ itemId, response }]
 * @returns {{ perItem, perCriterion, totalItems, totalCorrect, reproducibilityHash, scorerVersion }}
 */
function scoreSession({ paper, assembledItems, responses }) {
  const itemsById = new Map((paper.items || []).map((i) => [i.id, i]));
  const responseByItem = new Map((responses || []).map((r) => [r.itemId, r.response]));

  const perItem = [];
  const perCriterionMap = new Map();

  for (const assembled of assembledItems || []) {
    const item = itemsById.get(assembled.itemId);
    if (!item) continue; // structurally impossible on a frozen paper; skip rather than crash
    const response = responseByItem.get(assembled.itemId);
    const answered = isAnswered(item.type, response);
    const correct = isCorrect(item, response);
    perItem.push({ itemId: item.id, correct, answered });

    const agg = perCriterionMap.get(item.criterionId) || { criterionId: item.criterionId, itemCount: 0, correctCount: 0 };
    agg.itemCount += 1;
    if (correct) agg.correctCount += 1;
    perCriterionMap.set(item.criterionId, agg);
  }

  const perCriterion = [...perCriterionMap.values()].sort((a, b) => a.criterionId.localeCompare(b.criterionId));
  const totalItems = perItem.length;
  const totalCorrect = perItem.filter((p) => p.correct).length;

  const itemSetHash = sha256(stableStringify((assembledItems || []).map((a) => ({ i: a.itemId, o: a.optionOrder || [] }))));
  const responsesHash = sha256(stableStringify(perItem.map((p) => ({ i: p.itemId, c: p.correct, a: p.answered }))));
  const reproducibilityHash = sha256(`${paper.version}|${itemSetHash}|${responsesHash}|${SCORER_VERSION}`);

  return { perItem, perCriterion, totalItems, totalCorrect, reproducibilityHash, scorerVersion: SCORER_VERSION };
}

/**
 * Deterministic claim-verdict rule (A3.2): over the items that TARGETED a claim —
 *   all correct           → verified
 *   majority incorrect    → contradicted (surfaced to a human, NEVER auto-reject)
 *   else                  → inconclusive
 */
function claimVerdicts({ paper, assembledItems, perItem }) {
  const correctByItem = new Map((perItem || []).map((p) => [p.itemId, p.correct]));
  const itemsById = new Map((paper.items || []).map((i) => [i.id, i]));
  const byClaim = new Map();

  for (const assembled of assembledItems || []) {
    if (!assembled.targetsClaimId) continue;
    const group = byClaim.get(assembled.targetsClaimId) || { itemIds: [], criterionId: "" };
    group.itemIds.push(assembled.itemId);
    if (!group.criterionId) group.criterionId = itemsById.get(assembled.itemId)?.criterionId || "";
    byClaim.set(assembled.targetsClaimId, group);
  }

  const verdicts = [];
  for (const [claimId, group] of byClaim) {
    const itemCount = group.itemIds.length;
    const correctCount = group.itemIds.filter((id) => correctByItem.get(id)).length;
    const incorrectCount = itemCount - correctCount;
    let verdict = "inconclusive";
    if (itemCount > 0 && correctCount === itemCount) verdict = "verified";
    else if (incorrectCount > itemCount / 2) verdict = "contradicted";
    verdicts.push({ claimId, criterionId: group.criterionId, verdict, itemIds: group.itemIds, correctCount, itemCount });
  }
  return verdicts.sort((a, b) => a.claimId.localeCompare(b.claimId));
}

module.exports = { SCORER_VERSION, isAnswered, isCorrect, scoreSession, claimVerdicts, stableStringify };
