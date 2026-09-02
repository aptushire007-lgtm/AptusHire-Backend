// The "reflect" step: what the interviewer says between an answer and the next question, and
// whether the answer earned a follow-up.
//
// ONE model call per turn produces BOTH outputs, because they read the same two pieces of text
// (the question just asked, the answer just given) and a second round-trip would add a second
// second of dead air to every turn in the interview. Both outputs are then verified in code —
// the lead-in by utils/groundedAck, the follow-up by utils/questionVetting plus the checks below.
//
// WHY A FOLLOW-UP IS NOT THE SAME KIND OF THING AS AN APPROVED QUESTION, and why the code keeps
// them apart. The recruiter-approved question set is the INSTRUMENT: every candidate for a role
// gets it word for word, which is what makes two candidates' scores comparable and a bias audit
// possible. A follow-up is, by construction, different for every candidate — it exists precisely
// because it responds to what this person said. That makes it excellent evidence and a terrible
// basis for comparison.
//
// So a follow-up:
//   * is stored with kind "follow_up", never merged into the approved set, and shown to a
//     reviewer as an adaptive question rather than part of the instrument;
//   * is CAPPED (MAX_FOLLOW_UPS), so the approved instrument always dominates the interview and
//     a chatty model cannot quietly turn a structured interview into a free conversation;
//   * can never displace an approved question or a claim-probe — closing is still gated on those
//     being covered (see aiInterviewService.closingAllowed), and a follow-up counts toward
//     nothing except its own cap.
//
// WHAT THE FOLLOW-UP IS FOR. Answers that assert something without evidencing it. The candidate
// says "I used Node for an AI recruitment platform" — the claim is now on the record and entirely
// unproven, and the fastest way to find out whether they built it or watched someone build it is
// to ask what Node did there. This is the Claim → Probe → Verdict loop operating on speech
// instead of on a résumé, which is the whole reason screening and interviewing are one system
// here rather than two products.
//
// It is emphatically NOT for telling the candidate their answer was thin. "Could you also explain
// the missing part?" announces a gap; "what did Node do there?" asks about the same gap and tells
// them nothing about their standing. The second one gets better evidence AND is the only one of
// the two that a company can defend, so there is no trade-off to make.

const { fenceUntrusted } = require("./promptSafety");
const { questionIssues } = require("./questionVetting");
const backchannel = require("./backchannel");
const groundedAck = require("./groundedAck");
const questionSimilarity = require("./questionSimilarity");

// Bump when any prompt in this file changes — stored decisions record which wording produced them.
// 2026-08-18.1: the reflect call can finally remember. It now receives the recent exchanges
// (historyBlock) and the candidate's verified résumé spans (resumeBlock), and may press once for a
// concrete particular when the question it is reflecting on was itself a follow-up.
const REFLECT_PROMPT_VERSION = "2026-08-18.1";

// How many adaptive follow-ups one interview may contain. Deliberately small: past this, the
// minutes are coming out of the approved instrument, and the interview a recruiter designed is
// not the interview that ran. Env-tunable so a tenant can dial it to zero and get the old
// behaviour exactly.
const MAX_FOLLOW_UPS = Number(process.env.INTERVIEW_MAX_FOLLOW_UPS || 4);

// A follow-up is only offered when the answer gave it something to bite on. Below this, there is
// no specific in the answer to pursue and a "follow-up" would just be the interviewer asking the
// candidate to say more — which is pressure, not a question.
const FOLLOW_UP_MIN_ANSWER_WORDS = Number(process.env.INTERVIEW_FOLLOW_UP_MIN_WORDS || 15);

// ---------------------------------------------------------------------------
// The interviewer's framing — role-agnostic, JD-driven
// ---------------------------------------------------------------------------

// utils/interviewPrompts.INTERVIEWER_SYSTEM opens with "You are an experienced senior TECHNICAL
// interviewer". For a marketing, finance, operations or clinical role that is simply the wrong
// interviewer, and it shows up exactly where it does most damage: the model reaches for
// engineering competencies the rubric never mentioned, and asks a content strategist about
// system design because the prompt told it that is what interviews are.
//
// The fix is not to classify the job into a domain — a classifier is one more unaccountable
// decision, and it would be wrong about the interesting roles (a marketing engineer, a clinical
// data manager). The domain is already stated authoritatively in the job description, so the
// prompt says so and stops asserting a domain of its own.
function interviewerSystemFor(job, { securitySentence = "" } = {}) {
  const title = String(job?.title || "").trim();
  return (
    "You are an experienced senior interviewer conducting a live, voice-style interview" +
    (title ? ` for the ${title} role` : "") +
    ". " +
    "The job description defines the domain of this interview — it may be engineering, marketing, sales, " +
    "operations, finance, design, clinical, or anything else. Never assume it is a software role, and never " +
    "reach for competencies the job description does not ask for. " +
    "Behave like a real human interviewer, not a chatbot: ask one focused question at a time, listen to the full " +
    "answer, probe with natural follow-ups, adapt difficulty to the candidate's demonstrated level, and never repeat " +
    "a question. Keep each spoken turn concise (1-3 sentences). Judge answers on correctness, depth, and practical " +
    "understanding of THIS role's work — not keyword matching. " +
    securitySentence
  );
}

// ---------------------------------------------------------------------------
// The reflect call
// ---------------------------------------------------------------------------

const REFLECT_SYSTEM =
  "You are the listening half of a structured job interview. You read one question and the " +
  "candidate's answer to it, and you produce two things: a short spoken lead-in that names " +
  "something the candidate actually said, and optionally one follow-up question about a specific " +
  "they mentioned but did not evidence. " +
  "You never assess the answer, never say or imply whether it was right, wrong, complete or thin, " +
  "and never state any conclusion about the candidate. You are not permitted to give feedback of " +
  "any kind — that happens elsewhere, later, and is reviewed by a person.";

const REFLECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    // The exact words from the answer that the lead-in is built on. Verified as a literal
    // substring of the transcript before anything is spoken (groundedAck.termIsGrounded).
    term: { type: "string" },
    leadIn: { type: "string" },
    // Whether the answer left a specific worth pursuing. The model's recommendation only —
    // whether a follow-up is actually asked is decided by code (cap, vetting, grounding).
    followUpWorthwhile: { type: "boolean" },
    followUp: { type: "string" },
    // What the follow-up is trying to find out, for the reviewer. Never spoken.
    followUpRationale: { type: "string" },
  },
  required: ["term", "leadIn", "followUpWorthwhile", "followUp", "followUpRationale"],
};

// WHAT HAS ALREADY BEEN SAID IN THIS INTERVIEW.
//
// THE FAILURE THIS FIXES. Until this existed, the reflect call received exactly two strings: the
// question just asked and the answer just given. Nothing else. So the half of the interviewer that
// composes the responsive, human-sounding part of every turn was structurally incapable of
// remembering anything — it could not follow up on something raised three questions ago, could not
// notice that this answer contradicts an earlier one, and could not avoid pursuing a specific the
// candidate had already been asked about twice. It presented exactly as "it isn't listening",
// because in the only sense that matters it was not.
//
// Kept SHORT deliberately. This call sits on the critical path between the candidate finishing a
// sentence and the interviewer speaking, so every token here is silence the candidate hears. The
// last few exchanges carry almost all of the conversational continuity; the full transcript goes
// to the next-question call, which is a different decision with a different budget.
function historyBlock(history) {
  if (!Array.isArray(history) || history.length === 0) return "";
  const lines = history.map(
    (h) => `Q: ${h.question}\n   A: ${h.answer}`
  );
  return (
    `EARLIER IN THIS INTERVIEW (oldest first — this is what they have already told you):\n` +
    `${lines.join("\n")}\n\n`
  );
}

// WHAT THEIR RÉSUMÉ SAYS ABOUT THIS.
//
// Verified spans only (utils/resumeAnchors — every quote here has already been checked to be a
// literal substring of the uploaded document), so a follow-up can never ask a candidate to account
// for something their résumé does not actually say.
//
// The instruction below is the important half. A discrepancy between the document and the answer
// is a REASON TO ASK A QUESTION, never a finding to state and never a thing to point out. "Your
// résumé says three years but you just described six months" is an accusation delivered by a
// machine, mid-interview, on the strength of a speech transcript; "how long were you working on it
// directly?" gets the same information, gives the candidate the ordinary chance to explain, and is
// the version a company can defend. See the module header for why the same rule governs
// everything the interviewer says about an answer.
function resumeBlock(resumeFacts) {
  if (!Array.isArray(resumeFacts) || resumeFacts.length === 0) return "";
  const lines = resumeFacts.map((f) => `- ${f.term}: "${f.quote}"`);
  return (
    `WHAT THIS CANDIDATE'S RÉSUMÉ CLAIMS (verbatim from the document they uploaded):\n` +
    `${lines.join("\n")}\n` +
    `If what they just said sits oddly beside one of these — a shorter involvement, a smaller role, ` +
    `a different tool — that is a good reason to ask ONE open question about it. Never state the ` +
    `discrepancy, never quote their résumé back at them, and never imply they have contradicted ` +
    `themselves. Ask about the work; let them tell you.\n\n`
  );
}

function reflectPrompt({ roleTitle, roleContext, question, answer, followUpsRemaining, shapeHint, history, resumeFacts, isPress }) {
  const canFollowUp = followUpsRemaining > 0;
  return (
    `ROLE BEING INTERVIEWED FOR: ${roleTitle || "(not stated)"}\n` +
    (roleContext ? `WHAT THIS ROLE INVOLVES:\n${roleContext}\n\n` : "\n") +
    resumeBlock(resumeFacts) +
    historyBlock(history) +
    `THE QUESTION THEY WERE ASKED:\n${question}\n\n` +
    `WHAT THEY SAID (a speech transcript — expect false starts, repetition and unreliable ` +
    `punctuation, all of which are normal in speech):\n${fenceUntrusted(answer)}\n\n` +
    `Produce two things.\n\n` +
    `1. "term" and "leadIn".\n` +
    `   "term" — copy, EXACTLY as it appears in the transcript above, the most specific thing they ` +
    `named: a technology, a product, a campaign, a metric, a company, a decision, a problem they ` +
    `hit. Copy it character for character; do not correct, expand, or tidy it. If they named ` +
    `nothing specific, return "" for both fields.\n` +
    `   "leadIn" — what the interviewer SAYS out loud before moving on. It must contain "term", must ` +
    `NOT be a question, and must NOT end with a question mark.\n` +
    `   THIS IS SPEECH, NOT WRITING. Aim for about ${groundedAck.TARGET_LEAD_IN_WORDS} words and never ` +
    `exceed ${groundedAck.MAX_LEAD_IN_WORDS}. A complete, well-formed sentence is the clearest sign ` +
    `that a machine is talking — people acknowledge things with a FRAGMENT and move on. Drop the ` +
    `subject and verb where a person would. Use contractions. Put a comma or an em dash where you ` +
    `would draw breath, because that is what makes a line sound spoken rather than read aloud.\n` +
    (shapeHint
      ? `   USE THIS SHAPE THIS TIME: ${shapeHint}\n` +
        `   Match that shape rather than falling back on "You mentioned…". Saying it the same way ` +
        `every turn is exactly what makes an interviewer sound automated, and it is the specific ` +
        `thing this field exists to avoid.\n`
      : "") +
    `   Latch onto the MOST SPECIFIC thing in the answer, never the most general. A number, a product ` +
    `name, a place, a named system — that is what a person picks up on. "Two thousand a day" is a ` +
    `real acknowledgement; "the project" is not one at all.\n` +
    `   CRITICAL — "term" must appear, character for character, in BOTH the transcript AND your ` +
    `"leadIn". If you shorten the phrase when you say it out loud, which is natural, then make "term" ` +
    `the SHORTENED form: for a transcript reading "about two thousand leads a week" and a leadIn of ` +
    `"Two thousand a week, okay.", the correct term is "two thousand", because that is the part ` +
    `present in both. Getting this wrong means the interviewer says nothing at all this turn.\n` +
    `   FORBIDDEN, and the whole point of this instruction — do not say or imply anything about ` +
    `how the answer went. Never "that's correct", "you're on the right track", "not quite", ` +
    `"that makes sense", "it sounds like you have practical experience", "the way you explained ` +
    `that", "you clearly know this", "thanks for explaining your approach". Do not praise, do not ` +
    `soften, do not sympathise, and do not characterise the candidate. Name what they said and ` +
    `stop.\n\n` +
    `2. "followUpWorthwhile", "followUp" and "followUpRationale".\n` +
    (canFollowUp
      ? (isPress
          ? `   THE QUESTION ABOVE WAS ITSELF A FOLLOW-UP, and what you are reading is the answer to ` +
            `it. If that answer STILL contains no concrete particular — a number, a name, a tool, a ` +
            `decision they actually made, something only a person who did the work would know — you ` +
            `may press ONCE more. A press asks for one specific thing, narrowly: "how many were ` +
            `there?", "which part did you write?", "what did you decide in the end?". It never ` +
            `repeats the question, never says or implies they have not answered, and never signals ` +
            `that this is a second attempt. If they did give a particular — or if the honest reading ` +
            `is that they simply do not have one — set followUpWorthwhile to false. A candidate ` +
            `asked about the same thing three times is being interrogated, not interviewed.\n`
          : `   Set followUpWorthwhile to true ONLY when the answer asserts something specific that it ` +
            `does not evidence — a system they say they built, a result they claim, a decision they ` +
            `say they made — and one question would establish whether they did the work themselves. ` +
            `A long, fluent answer that names nothing concrete is exactly this case rather than an ` +
            `exception to it. Otherwise set it false and return "" for followUp.\n`) +
        `   "followUp" — ONE question, one sentence, spoken aloud, about something they actually ` +
        `said. It must be relevant to ${roleTitle || "this role"} and to what this role involves: ` +
        `for a marketing role ask about the campaign, the channel, the audience, the numbers; for ` +
        `an engineering role ask about the design, the failure, the trade-off. Ask what THEY did, ` +
        `what they decided, what went wrong, or what they would do differently.\n` +
        `   It must NOT contain, hint at, or lead toward the answer you expect. Do not ask a ` +
        `question that supplies the information it is asking for, and do not ask them to explain ` +
        `something you have implied they left out. Ask openly.\n` +
        `   It must NOT reference their age, family, marital status, children, health, disability, ` +
        `religion, ethnicity, nationality, visa or immigration status, or politics — not even if ` +
        `they raised it themselves.\n` +
        // Stated only when the block it refers to is actually present. Pointing the model at
        // "EARLIER IN THIS INTERVIEW above" on the first question describes a section that is not
        // there — a small incoherence, but the kind that makes a model hedge everything after it.
        (Array.isArray(history) && history.length
          ? `   DO NOT ask about anything already covered in EARLIER IN THIS INTERVIEW above. If the ` +
            `specific you want to pursue has already been asked about, set followUpWorthwhile to false ` +
            `rather than asking a narrower version of it — a candidate who has answered something twice ` +
            `has told you the interviewer is not listening.\n`
          : ``) +
        `   "followUpRationale" — one short line, for the hiring team only, naming what this ` +
        `question would establish. Never spoken to the candidate.\n\n`
      : `   No follow-ups remain in this interview. Set followUpWorthwhile to false and return "" ` +
        `for followUp and followUpRationale.\n\n`) +
    `Return JSON.`
  );
}

// ---------------------------------------------------------------------------
// Verifying the follow-up
// ---------------------------------------------------------------------------

// A follow-up must not lead. These are the shapes that hand the candidate the answer inside the
// question — the failure the spec was most explicit about ("do not reveal the expected answer").
// A leading question is also simply a bad measurement: it tells you the candidate can say yes.
const LEADING_RE = [
  // "Did you use X to do Y?" / "Was it because ...?" — closed questions that name the answer.
  /\b(?:did|was|were|is|are|do|does|have|has|had)\s+(?:you|it|they|that|the)\b[^?]*\bbecause\b/i,
  // "so you must have ...", "presumably you ..."
  /\b(?:must have|presumably|i assume|i imagine|no doubt)\b/i,
  // "..., right?" / "..., correct?" / "..., yes?" — invites agreement.
  /,\s*(?:right|correct|yes|no|isn't it|wasn't it|didn't you)\s*\?\s*$/i,
  // "Would you agree that ...?"
  /\bwould you agree\b/i,
  // Naming the technique the candidate is meant to produce ("did you use indexing to speed it up")
  // is impossible to catch generically, so the prompt carries that instruction and this list stays
  // to the shapes that are mechanically recognisable.
];

// A question does not have to end in "?" to be a question, and insisting that it does would reject
// the phrasings utils/questionSetPrompts explicitly asks recruiters' question sets to use —
// "walk me through…", "tell me about a time…". Those are the best-evidenced interview openers
// there are, so an adaptive follow-up is allowed to use them too.
const IMPERATIVE_PROBE_RE =
  /^\s*(?:so\s+)?(?:tell|walk|talk|describe|explain|share|give|help)\s+(?:me\b|us\b|through\b)?/i;

// Two questions in one breath. The candidate answers the second and the first is silently lost —
// and because both were stamped onto one turn, the transcript shows an unanswered question as if
// they declined to address it. Caught as a comma-or-dash joined second interrogative clause,
// which is the shape this actually takes ("what did Node do there, and how did you test it?").
const COMPOUND_RE =
  /[,;—-]\s*(?:and|or|also|then)\s+(?:what|how|why|when|where|which|who|whom|did|do|does|was|were|is|are|can|could|would|will|have|has|had)\b/i;

function isQuestionShaped(text) {
  return text.endsWith("?") || IMPERATIVE_PROBE_RE.test(text);
}

// Every reason a proposed follow-up is refused, as a named string. Same contract as
// groundedAck.rejectionFor: returned, recorded, never thrown.
function followUpRejectionFor(followUp, answerText, { term = "", asked = [] } = {}) {
  const text = String(followUp || "").trim();
  if (!text) return "empty";
  // A follow-up is a question like any other and must not repeat one. This check was absent
  // entirely: every other question in the interview passed through utils/questionSimilarity and
  // this one did not, so the single path most likely to circle back on ground already covered —
  // one composed from the answer to the question just asked — was the only unguarded one.
  if (Array.isArray(asked) && asked.length) {
    const dup = questionSimilarity.findDuplicate(text, asked);
    if (dup.duplicate) return "repeat:" + dup.reason;
  }
  if (!isQuestionShaped(text)) return "not_a_question";
  if (/[\n\r]/.test(text)) return "not_speech";
  // Two questions in one turn is the most common complaint about machine interviewers, and it
  // makes the answer impossible to attribute to either question.
  if ((text.match(/\?/g) || []).length > 1) return "multiple_questions";
  if (COMPOUND_RE.test(text)) return "multiple_questions";

  // A question is allowed to be neutral-technical but not evaluative: "what was weak about it"
  // characterises their work back at them.
  const evaluative = backchannel.findEvaluativeWord(text);
  if (evaluative) return "evaluative:" + evaluative;

  if (groundedAck.PERSONAL_CLAIM_RE.some((re) => re.test(text))) return "claims_about_candidate";
  if (LEADING_RE.some((re) => re.test(text))) return "leading";
  if (groundedAck.PROTECTED_RE.test(text)) return "protected_characteristic";

  // Reuse the recruiter-facing vetting the approved question set passes: length bounds, control
  // characters, and the protected-attribute patterns. One definition of "askable", so an adaptive
  // question can never be something a recruiter would have been blocked from typing.
  const issues = questionIssues(text);
  if (issues.length) return "vetting:" + issues[0].code;

  // Grounded in the answer, on the same cite-or-abstain rule as the lead-in: a follow-up about
  // something the candidate never said is a non-sequitur at best and, at worst, the interviewer
  // confusing this candidate with another one.
  const anchor = groundedAck.normalizeTerm(term);
  if (!anchor) return "no_anchor_term";
  if (!groundedAck.termIsGrounded(anchor, answerText)) return "anchor_not_in_answer";
  // Case-insensitive for the same reason groundedAck.containsPhrase is: a follow-up that opens on
  // the anchor capitalises it, and rejecting that would discard a perfectly good question.
  if (!groundedAck.containsPhrase(text, anchor)) return "anchor_absent_from_follow_up";

  return null;
}

/**
 * Decide whether to ask the model's proposed follow-up.
 *
 * Returns { ask, question, rationale, rejection }. `ask: false` is the normal, expected outcome
 * for most turns — the interview continues to the next approved question, which is what it was
 * going to do anyway.
 */
function decideFollowUp(proposal, answerText, { followUpsRemaining = 0, minAnswerWords = FOLLOW_UP_MIN_ANSWER_WORDS, asked = [] } = {}) {
  if (followUpsRemaining <= 0) {
    return { ask: false, question: "", rationale: "", rejection: "cap_reached" };
  }
  const words = (String(answerText || "").match(/[A-Za-z0-9']+/g) || []).length;
  if (words < minAnswerWords) {
    return { ask: false, question: "", rationale: "", rejection: "answer_too_short" };
  }
  if (!proposal || typeof proposal !== "object" || !proposal.followUpWorthwhile) {
    return { ask: false, question: "", rationale: "", rejection: "not_proposed" };
  }
  const rejection = followUpRejectionFor(proposal.followUp, answerText, { term: proposal.term, asked });
  if (rejection) {
    return { ask: false, question: "", rationale: "", rejection };
  }
  return {
    ask: true,
    question: String(proposal.followUp).trim(),
    rationale: String(proposal.followUpRationale || "").trim(),
    rejection: null,
  };
}

module.exports = {
  REFLECT_PROMPT_VERSION,
  MAX_FOLLOW_UPS,
  FOLLOW_UP_MIN_ANSWER_WORDS,
  LEADING_RE,
  COMPOUND_RE,
  IMPERATIVE_PROBE_RE,
  isQuestionShaped,
  interviewerSystemFor,
  REFLECT_SYSTEM,
  REFLECT_SCHEMA,
  reflectPrompt,
  followUpRejectionFor,
  decideFollowUp,
};
