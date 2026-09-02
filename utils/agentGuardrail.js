// What the realtime interviewer is not allowed to say, checked against what it actually said.
//
// THE PROBLEM THIS SOLVES. services/voiceAgentService.js hands a conversational model the
// microphone. That buys the naturalness a hand-rolled turn-taking client could never reach, and
// it costs the guarantee utils/speechAuthorization.js used to provide: that every spoken word was
// an authored turn or an approved phrase, verifiable by exact match. A model that improvises
// warmth drifts, and it drifts in a predictable direction — toward the small talk humans make,
// which is made of family, age, health, and where someone is "originally" from.
//
// So the prompt tells it not to (that is prevention), and this file checks whether it did (that is
// enforcement). Prevention alone is not a control: "we asked the model nicely" is not an answer to
// a regulator, and it is not an answer to a candidate who says the AI asked about their kids.
//
// WHY DETERMINISTIC, NOT A SECOND MODEL. Three reasons, in order of importance:
//   1. A control that is itself a model has the same failure mode as the thing it is controlling,
//      and no better account of itself. "Why was this interview halted?" must be answerable with
//      a rule and a matched phrase, not with a second opinion.
//   2. It runs on the transcript, off the audio path, so it must be fast enough to be free. It is.
//   3. It has to behave identically for every candidate. A model-based check that is stricter on
//      some transcripts than others is a fairness problem wearing a safety badge.
//
// THE FALSE-POSITIVE RULE. A critical hit HALTS a live interview, which is a serious thing to do
// to someone who took time off work for it. So the critical patterns are deliberately narrow and
// interrogative — they match the interviewer ASKING, not any mention of a topic. Everything
// broader is `flag`, which costs the candidate nothing and surfaces to a human. When in doubt,
// flag; never halt.

const MAX_SCAN_CHARS = 4000;

function toWordRegex(phrase) {
  const words = String(phrase || "").toLowerCase().match(/[a-z0-9']+/g) || [];
  if (!words.length) return null;
  const parts = words.map((w) => w.replace(/'/g, "'?"));
  return new RegExp(`\\b${parts.join("[^a-z0-9]+")}\\b`, "i");
}

// ---------------------------------------------------------------------------
// Affect observation — "you sound / you seem / your tone …"
// ---------------------------------------------------------------------------
//
// The interviewer reading an emotional state off the candidate. Composed from two lists rather
// than enumerated as phrases, because the phrase-list version failed on the first natural sentence
// tried against it: it caught "you seem unsure" and missed "you seem a bit unsure".
//
// The opener has to be an OBSERVATION of the person ("you sound", "your tone"), not a question
// about their answer — "how confident are you in that estimate?" is a legitimate interview
// question about evidence, and must stay possible.

const AFFECT_OPENERS = [
  "you sound", "you sounded", "you're sounding", "you are sounding",
  "you seem", "you seemed", "you appear", "you appeared", "you look",
  "your tone", "your voice",
  "i can tell you're", "i can tell you are", "i can hear you're", "i can hear you are",
  "i can hear that you're", "i sense you're", "i sense that you're",
];

const AFFECT_WORDS = [
  "nervous", "anxious", "stressed", "upset", "tired", "exhausted", "worried", "scared",
  "panicked", "flustered", "rattled", "shaken", "emotional", "uncomfortable", "uneasy",
  "confident", "unsure", "uncertain", "hesitant", "tentative", "relaxed", "calm",
  "frustrated", "annoyed", "irritated", "bored", "distracted", "defensive", "overwhelmed",
];

// How many words may sit between the opener and the affect word. Four covers the hedges and
// adverbs people actually use ("a bit", "quite", "a little bit", "somewhat") without reaching
// across a sentence boundary into an unrelated clause.
const AFFECT_GAP_WORDS = 4;

const AFFECT_RE = new RegExp(
  `\\b(?:${AFFECT_OPENERS.map((o) => o.replace(/'/g, "'?").replace(/ /g, "\\s+")).join("|")})\\b` +
    `(?:\\W+\\w+){0,${AFFECT_GAP_WORDS}}\\W+\\b(?:${AFFECT_WORDS.join("|")})\\b`,
  "i"
);

function matchAffectObservation(text) {
  const m = AFFECT_RE.exec(String(text || ""));
  return m ? m[0].slice(0, 120) : null;
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

const RULES = [
  {
    id: "protected_characteristic",
    severity: "critical",
    // The interviewer ASKING about a protected characteristic. Every one of these is a question a
    // real interviewer has asked and an employer has been sued over. Phrased as interrogatives on
    // purpose: "she mentioned her kids" in a candidate's answer is not this, and the agent
    // repeating a topic back neutrally is not this either.
    label: "asked about a protected characteristic",
    patterns: [
      "how old are you",
      "what is your age",
      "what's your age",
      "when were you born",
      "what year were you born",
      "are you married",
      "do you have a family",
      "do you have children",
      "do you have kids",
      "are you planning to have",
      "are you pregnant",
      "do you have any health",
      "any health conditions",
      "are you disabled",
      "do you have a disability",
      "what is your religion",
      "what's your religion",
      "do you go to church",
      "what is your ethnicity",
      "what's your ethnicity",
      "what is your nationality",
      "what's your nationality",
      "where are you originally from",
      "where are you really from",
      "what is your visa status",
      "what's your visa status",
      "do you need sponsorship",
      "are you a citizen",
      "who did you vote for",
      "are you single",
      "what is your sexual orientation",
    ],
  },
  {
    id: "compensation_or_offer",
    severity: "critical",
    // The agent has no authority to say any of this and the company is bound by what a candidate
    // was told in an interview. Also narrow and commissive — discussing the ROLE is fine.
    label: "made a commitment about pay, terms, or an offer",
    patterns: [
      "we can offer you",
      "we'll offer you",
      "the salary is",
      "your salary would be",
      "we would pay you",
      "you'll be paid",
      "you have the job",
      "you've got the job",
      "you're hired",
      "consider yourself hired",
      "when can you start",
      "we'd like to offer",
    ],
  },
  {
    id: "outcome_disclosure",
    severity: "critical",
    // Telling a candidate their result is an automated adverse (or falsely favourable) action
    // delivered with no human in the loop — rule 6, in the most direct form it takes. The agent
    // also simply does not know: scoring happens afterwards, elsewhere, deterministically.
    label: "told the candidate their result",
    patterns: [
      "you have passed",
      "you've passed",
      "you have failed",
      "you've failed",
      "you did not pass",
      "you didn't pass",
      "you won't be moving forward",
      "you will not be moving forward",
      "you're moving forward",
      "you'll be moving forward",
      "you're through to",
      "your score is",
      "your score was",
      "i'm rejecting",
      "we're rejecting you",
    ],
  },
  {
    id: "emotion_inference",
    severity: "critical",
    // Inferring emotion from voice in a hiring context is a PROHIBITED practice under EU AI Act
    // Article 5(1)(f) — not high-risk, prohibited, in force since Feb 2025, with "workplace" read
    // broadly enough to cover recruitment explicitly. Penalties reach €35M or 7% of global
    // turnover. The prompt forbids it; this is the check that it held.
    //
    // Independently of the law it is bad measurement: what voice-affect inference actually detects
    // is accent, neurodivergence, a head cold and a cheap microphone. This codebase already
    // removed `deliveryScore` for exactly that reason.
    label: "commented on or inferred the candidate's emotional state from how they sound",
    // Patronising imperatives, which are affect commentary even without naming the emotion.
    patterns: ["try to relax", "calm down", "don't be nervous", "there's no need to be nervous"],
    // Everything else is COMPOSITIONAL, not a phrase list. A flat list loses to ordinary English:
    // "you seem unsure" was matched and "you seem a bit unsure" was not, which is the difference
    // between a control and a coincidence. This matches an observation opener followed closely by
    // an affect word, so the adverbs, hedges and filler people actually speak cannot slip past it.
    match: matchAffectObservation,
  },
  {
    id: "evaluative_feedback",
    severity: "high",
    // Rating an answer to the candidate's face. Not halted, because the harm is contamination and
    // uneven encouragement rather than an illegal question — but it is a real defect: praise
    // changes what someone says next, so an interview that praises some answers and not others has
    // stopped measuring the same thing for everyone.
    //
    // Matched as PHRASES directed at the answer, never as bare adjectives. "What does good code
    // mean to you?" is a legitimate question containing "good", and a bare-word check would flag
    // it — see backchannel.EVALUATIVE_WORDS, which can afford to be strict because it guards a
    // fixed bank rather than live speech.
    label: "gave the candidate feedback on how well they answered",
    patterns: [
      "great answer",
      "good answer",
      "excellent answer",
      "perfect answer",
      "well answered",
      "that's exactly right",
      "exactly right",
      "that's correct",
      "that's right",
      "you're right",
      "that's wrong",
      "that's incorrect",
      "not quite right",
      "that's not quite",
      "you seem very experienced",
      "you clearly know",
      "you obviously know",
      "that's impressive",
      "very impressive",
      "i'm impressed",
      "you're doing great",
      "you're doing well",
      "good job",
      "well done",
      "that was a strong",
      "that was a weak",
    ],
  },
];

// Compiled once. These are constants; recompiling per utterance on a live path is waste.
const COMPILED = RULES.map((rule) => ({
  ...rule,
  regexes: rule.patterns.map((p) => ({ phrase: p, re: toWordRegex(p) })).filter((x) => x.re),
}));

// ---------------------------------------------------------------------------
// Off-script questions — "the relevant questions, asked properly"
// ---------------------------------------------------------------------------
//
// The interviewer is given its questions one at a time and told to ask them essentially word for
// word (services/voiceAgentService). A model that invents its own question has, for that
// candidate, replaced part of the approved instrument with something nobody reviewed — and the
// comparison between candidates that the whole interview exists to support quietly stops being
// valid. That is the failure this catches, and it is the one most likely to happen, because
// asking a natural follow-up is exactly what a good conversationalist does.
//
// The interviewer still has to be able to TALK, so ordinary conversational questions are allowed
// outright. This list is what a real interviewer says between questions and says to everyone.
const CONVERSATIONAL_QUESTIONS = [
  "does that make sense",
  "shall i repeat",
  "would you like me to repeat",
  "should i repeat",
  "do you want me to repeat",
  "could you say that again",
  "can you say that again",
  "are you ready",
  "ready to start",
  "can you hear me",
  "are you still there",
  "anything you'd like to add",
  "anything else you'd like to add",
  "is there anything else",
  "would you like to end the interview",
  "would you like a moment",
  "do you need a moment",
  "take your time",
  "how are you",
  "how are you doing",
  "shall we begin",
  "shall we start",
  "are you happy to",
  "is that everything",
  "did you want to add",
  "would you like me to move on",
  "shall i move on",
  "does that answer",
  "what do you mean",
  "could you tell me more",
  "can you tell me more",
  "could you say a bit more",
  "can you say a bit more",
];

const CONVERSATIONAL_RES = CONVERSATIONAL_QUESTIONS.map(toWordRegex).filter(Boolean);

// A question short enough to be conversational glue rather than an instrument question. "Sorry,
// what?" is not a new interview question; a twelve-word probe about Kubernetes is.
const MIN_SUBSTANTIVE_QUESTION_WORDS = 7;

function wordCount(text) {
  return (String(text || "").match(/[A-Za-z0-9']+/g) || []).length;
}

// Interrogative by shape, not just by punctuation — speech transcripts lose question marks
// constantly, and "tell me about a time you disagreed with a technical decision" is an instrument
// question with no question mark at all.
const INTERROGATIVE_OPENERS =
  /^(what|why|how|when|where|which|who|whose|can|could|would|will|do|does|did|are|is|was|were|have|has|had|tell me|walk me|describe|explain|give me an example)\b/i;

function looksLikeQuestion(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  return t.includes("?") || INTERROGATIVE_OPENERS.test(t);
}

function isConversational(text) {
  return CONVERSATIONAL_RES.some((re) => re.test(text));
}

// Loose normalisation for comparing speech against authored text — case, punctuation, whitespace.
function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Share of an authored question's words that must appear, contiguous and in order, for an
// utterance to count as that question rather than a reworded cousin of it.
const QUESTION_MATCH_SHARE = 0.6;

function containsAuthored(utterance, authored) {
  const hay = normalize(utterance);
  const q = normalize(authored);
  if (!hay || !q) return false;
  if (hay.includes(q)) return true;
  const words = q.split(" ");
  const need = Math.max(4, Math.ceil(words.length * QUESTION_MATCH_SHARE));
  for (let start = 0; start + need <= words.length; start += 1) {
    if (hay.includes(words.slice(start, start + need).join(" "))) return true;
  }
  return false;
}

/**
 * Did the interviewer ask something that is not in the approved instrument?
 *
 * `authorized` is every question this session has legitimately been handed (aiInterview
 * .askedQuestions). Checked against ALL of them rather than only the current one, because a model
 * that circles back to an earlier question is being repetitive, not off-script — and repetitive is
 * not a safety finding.
 */
function scanQuestionFidelity(utterance, authorized = []) {
  const text = String(utterance || "").slice(0, MAX_SCAN_CHARS);
  if (!looksLikeQuestion(text)) return null;
  if (isConversational(text)) return null;
  if (wordCount(text) < MIN_SUBSTANTIVE_QUESTION_WORDS) return null;
  if ((authorized || []).some((q) => containsAuthored(text, q))) return null;
  return {
    ruleId: "off_script_question",
    // Flag, never halt. A model asking one unapproved follow-up is a real finding a recruiter must
    // see, and it is not grounds for destroying a candidate's interview mid-sentence — especially
    // since the likeliest cause is an over-eager clarification of a question we ourselves gave it.
    severity: "high",
    label: "asked a question that was not part of the approved set",
    matched: text.slice(0, 300),
  };
}

/**
 * Scan one thing the interviewer said.
 *
 * Returns { hits: [...], severity: "critical" | "high" | null }. `hits` carries the rule and the
 * matched phrase, because "what exactly did it say, and which rule did that break" is the whole
 * point — a count cannot answer a complaint.
 */
function scan(utterance, { authorizedQuestions = [] } = {}) {
  const text = String(utterance || "").slice(0, MAX_SCAN_CHARS);
  const hits = [];
  if (!text.trim()) return { hits, severity: null };

  for (const rule of COMPILED) {
    let matched = null;
    for (const { phrase, re } of rule.regexes) {
      if (re.test(text)) { matched = phrase; break; }
    }
    // Rules that need more than a phrase list (see matchAffectObservation) supply their own
    // matcher. It returns the text it matched, so the finding still names what actually fired.
    if (!matched && typeof rule.match === "function") matched = rule.match(text);
    if (!matched) continue;
    hits.push({ ruleId: rule.id, severity: rule.severity, label: rule.label, matched });
  }

  const drift = scanQuestionFidelity(text, authorizedQuestions);
  if (drift) hits.push(drift);

  const severity = hits.some((h) => h.severity === "critical")
    ? "critical"
    : hits.length
      ? "high"
      : null;
  return { hits, severity };
}

// Should a live interview be stopped over this?
//
// Only `critical`. The bar is deliberately high: halting costs a candidate an interview they
// prepared for and took time off for, and the remedy for everything else — a flag on the report a
// human reads — costs them nothing at all.
function shouldHalt(severity) {
  return severity === "critical";
}

// What the candidate is told when a halt happens.
//
// It must not read as their fault, because it is not: the interviewer went off-script. It also
// must not explain what the interviewer said — repeating an unlawful question to the candidate to
// apologise for it is worse than the original. Neutral, brief, and it promises a human, because
// rule 6 means a halted interview can never be an automated adverse action.
const HALT_MESSAGE =
  "We've had to stop this interview early for a technical reason on our side. This is not about " +
  "your answers, and it will not count against you. A member of the hiring team will review your " +
  "application and be in touch about next steps.";

/**
 * Everything this session's interviewer is authorized to have said as a question.
 *
 * `askedQuestions` alone is NOT that list: the engine also authors the intro, the name check and
 * its retry, the warmup, nudges, the closing sequence and the closing script — all pushed as
 * ai-role turns before they are spoken, none of them in askedQuestions. Scanning against
 * askedQuestions alone flags the interviewer for reading the instrument's own script: a real
 * 2026-08-17 session carried five off-script findings and every one was the authored name-check
 * ask. Every ai-role turn is engine-authored by construction (the model's own utterances never
 * enter `turns`), so "authored" is checkable as "already in the turn record".
 */
function authorizedUtterances(ai) {
  return [
    ...((ai && ai.askedQuestions) || []),
    ...(((ai && ai.turns) || []).filter((t) => t && t.role === "ai" && t.text).map((t) => t.text)),
  ];
}

module.exports = {
  RULES,
  CONVERSATIONAL_QUESTIONS,
  MIN_SUBSTANTIVE_QUESTION_WORDS,
  QUESTION_MATCH_SHARE,
  HALT_MESSAGE,
  scan,
  scanQuestionFidelity,
  shouldHalt,
  looksLikeQuestion,
  isConversational,
  containsAuthored,
  normalize,
  authorizedUtterances,
};
