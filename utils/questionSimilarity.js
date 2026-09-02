// Has this question already been asked?
//
// THE FAILURE THIS FIXES. The interview asks the same thing twice. Candidates report it as the
// single most obviously-broken thing about talking to the system, and they are right: a human
// interviewer who re-asked a question you had just answered would be telling you they were not
// listening. It also corrupts the record — two answers to the same question, both scored, both
// folded into the mean, as though the candidate had covered two competencies.
//
// WHY IT HAPPENED. The next-question prompt carries an ALREADY ASKED list and the instruction
// "Never repeat an already-asked question", and that was the entire defence. The deterministic
// fallback path filtered its question pool against the same list IN CODE (aiInterviewService's
// fallbackQuestion) — so the fallback could not repeat itself and the model could. An instruction
// is not a guarantee, and this is the guarantee.
//
// WHY IT IS A SIMILARITY TEST AND NOT AN EQUALITY TEST. The model does not emit the same STRING
// twice; it emits "Can you explain how you used Node.js in practice?" and then, four turns later,
// "How have you used Node.js in your work?" A set-equality check on the raw text catches neither.
// What a candidate experiences as "you already asked me that" is two questions that are ABOUT the
// same thing, which is a question about content words, not characters.
//
// WHY DETERMINISTIC AND NOT A MODEL CALL. Three reasons, in order of importance. It is a decision
// that changes what a candidate is asked, so it has to be reproducible from the record — the same
// transcript must always yield the same verdict, which a sampled model cannot promise. It runs on
// every turn, so a round-trip here is a round-trip added to every interview (see #5, latency). And
// it is the kind of judgement code is actually good at, which is the general rule this codebase
// runs on: the model reads text, code decides.
//
// CALIBRATION. The two thresholds below are set to over-catch rather than under-catch, because
// the costs are wildly asymmetric. A false positive costs one extra model call to regenerate a
// question nobody heard. A false negative costs a candidate hearing the same question twice, in a
// recorded interview, and a duplicated score in their evaluation. When in doubt, regenerate.

// Words that carry no topic. Deliberately includes the interrogative frame ("how", "what", "tell",
// "describe", "explain", "walk") — every question in a structured interview opens with one of
// these, so leaving them in would make every pair of questions look 30% similar before either had
// said anything, and the thresholds would have to be raised to compensate. Stripping the frame is
// what makes the remaining overlap mean "same subject matter".
const STOPWORDS = new Set([
  "a", "about", "an", "and", "any", "are", "as", "at", "be", "been", "being", "but", "by", "can",
  "could", "describe", "did", "do", "does", "explain", "for", "from", "give", "had", "has", "have",
  "how", "i", "if", "in", "into", "is", "it", "its", "just", "like", "make", "me", "might", "more",
  "most", "much", "must", "my", "of", "on", "one", "or", "other", "our", "out", "over",
  "share", "should", "so", "some", "story", "such", "take", "tell", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "thing", "things", "this", "those", "through", "time",
  "to", "told", "up", "us", "use", "using", "very", "walk", "was", "way", "we", "were", "what",
  "when", "where", "which", "while", "who", "why", "will", "with", "would", "you", "your", "yours",
]);

// A deliberately crude suffix stripper. It exists so "owned" and "own", "migrating" and
// "migration" do not read as different topics — not to be a linguistically defensible stemmer.
// Length floors keep it off short words where the suffix is usually part of the stem ("used",
// "less", "this").
function stem(word) {
  let w = word;
  if (w.length > 6 && w.endsWith("ation")) return w.slice(0, -5);
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith("es")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  // "manage"/"managed" → "manag"/"manag" only if the trailing e also goes.
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

/**
 * The topic words of a question, as a Set. Punctuation and case go; "Node.js" and "node.js"
 * collapse together; stopwords and the interrogative frame are dropped.
 */
function contentWords(text) {
  const raw = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9.+#\s-]/g, " ")
    // Keep dots INSIDE a token ("node.js", "3.5") and drop sentence-final ones.
    .replace(/\.(?=\s|$)/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
  const out = new Set();
  for (const word of raw) {
    if (STOPWORDS.has(word)) continue;
    if (word.length < 2) continue;
    out.add(stem(word));
  }
  return out;
}

function intersectionSize(a, b) {
  let n = 0;
  for (const v of a) if (b.has(v)) n += 1;
  return n;
}

// Overlap as a fraction of ALL distinct topic words across both questions. Catches two questions
// that are broadly the same shape and subject.
const DUPLICATE_JACCARD = 0.6;
// Overlap as a fraction of the SHORTER question's topic words. Catches the commonest real case,
// which is not two similar questions but a short one wholly contained in a longer one: "How have
// you used Node.js?" inside "Can you explain how you've used Node.js in practice, and a
// limitation you ran into?" — Jaccard says 0.33 and a candidate says "you already asked me that".
// Set low on purpose: near-synonyms the token test cannot see ("in practice" / "in your work")
// each cost a word of overlap, so a threshold tuned for identical vocabulary misses the real
// repeats. Over-catching costs one regeneration; under-catching costs a candidate.
const DUPLICATE_CONTAINMENT = 0.65;
// Below this many topic words, containment is meaningless: a ONE-word question ("Tell me about
// Redis") is contained in half the English language. At two words the test still bites hard,
// because clearing 0.65 on a two-word question requires BOTH words shared — which is not a
// resemblance, it is the same question. "Describe your experience with Kubernetes" and "What is
// your experience running Kubernetes in production?" are the case this floor has to admit.
const MIN_CONTAINMENT_WORDS = 2;

/**
 * How alike are two questions? Returns the raw numbers alongside the verdict so a rejection can
 * be logged and explained rather than being a mystery in a transcript six weeks later.
 *
 * @returns {{duplicate: boolean, jaccard: number, containment: number, reason: string|null}}
 */
function compare(a, b) {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (!wa.size || !wb.size) {
    return { duplicate: false, jaccard: 0, containment: 0, reason: null };
  }
  const shared = intersectionSize(wa, wb);
  const union = wa.size + wb.size - shared;
  const jaccard = union ? shared / union : 0;
  const smaller = Math.min(wa.size, wb.size);
  const containment = smaller ? shared / smaller : 0;

  if (jaccard >= DUPLICATE_JACCARD) {
    return { duplicate: true, jaccard, containment, reason: "jaccard" };
  }
  if (smaller >= MIN_CONTAINMENT_WORDS && containment >= DUPLICATE_CONTAINMENT) {
    return { duplicate: true, jaccard, containment, reason: "containment" };
  }
  return { duplicate: false, jaccard, containment, reason: null };
}

/**
 * Is `question` a repeat of something in `asked`? Returns the matched prior question so the
 * regeneration prompt can name it ("you already asked X — ask about something else") rather than
 * repeating the generic instruction that just failed.
 *
 * @returns {{duplicate: boolean, matched: string|null, reason: string|null, jaccard: number}}
 */
function findDuplicate(question, asked) {
  const text = String(question || "").trim();
  if (!text) return { duplicate: false, matched: null, reason: null, jaccard: 0 };
  let worst = { duplicate: false, matched: null, reason: null, jaccard: 0 };
  for (const prior of asked || []) {
    const result = compare(text, prior);
    if (result.duplicate) {
      return { duplicate: true, matched: prior, reason: result.reason, jaccard: result.jaccard };
    }
    if (result.jaccard > worst.jaccard) worst = { ...worst, jaccard: result.jaccard };
  }
  return worst;
}

module.exports = {
  STOPWORDS,
  DUPLICATE_JACCARD,
  DUPLICATE_CONTAINMENT,
  MIN_CONTAINMENT_WORDS,
  stem,
  contentWords,
  compare,
  findDuplicate,
};
