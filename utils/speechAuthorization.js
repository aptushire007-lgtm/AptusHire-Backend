// Code-verified answer to "what did the interviewer actually say?"
//
// This is the control that makes the whole persona layer defensible, and it is the thing
// competitors structurally cannot offer. A vendor that hands the interview to an unconstrained
// speech-to-speech model has no record distinguishing the question they designed from whatever the
// model happened to say — so when a candidate reports "the AI asked me about my kids", there is
// nothing to check. Warmth and auditability look like a trade-off right up until you separate the
// author from the renderer, which is exactly what this file enforces.
//
// The mechanism is narrow on purpose. Every word the interviewer speaks goes through ONE endpoint
// (POST /interview-portal/voice/speak). So there is exactly one place to stand: before synthesizing
// anything, check the text against the closed set of things this session is allowed to hear —
//
//   1. text this session's own transcript already contains as an interviewer turn (the intro,
//      the questions compiled from the versioned rubric and claim probes, the closing), and
//   2. the fixed, human-approved, boot-checked non-evaluative phrase bank (utils/backchannel.js).
//
// Anything else is a divergence. It gets recorded verbatim, and — by default — refused. Note what
// that buys beyond today's client: if a future version of this system ever does hand a live model
// the microphone, this check is already the seam that catches it going off-script, and the record
// it leaves is the one you would need in a discrimination claim.
//
// Note the direction of the guarantee. This does not verify that the audio matched the text (that
// would need a speech model listening to our own output, and would be non-reproducible). It
// verifies that the TEXT sent for synthesis was authored by the rubric-bound engine or drawn from
// the approved bank. Combined with the fact that the client cannot synthesize any other way — the
// provider key never leaves the server — that is the property that actually matters.

const backchannel = require("./backchannel");

// Kept in step with speechService.synthesize's own truncation, so a long question is compared on
// the same footing it will be spoken.
const MAX_SPEAK_CHARS = 2000;

// Whitespace-only normalisation. Deliberately NOT lowercasing or stripping punctuation: the client
// is echoing back a string the server gave it, so anything beyond whitespace drift is a real
// difference and hiding it would defeat the point.
function norm(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").trim();
}

// Everything this session is allowed to say out loud, as a normalised set.
//
// The bank is rendered for THIS session's candidate, because some approved phrases carry their
// first name ("Thank you, Priya."). Rendering per session rather than accepting every name means
// one candidate's session can never authorise another candidate's sentence — a small hole, but
// in a mechanism whose entire value is having none.
function allowedFor(session) {
  const allowed = new Map(); // normalised text -> kind
  const firstName = session?.aiInterview?.candidateFirstName || "";
  for (const phrase of backchannel.allPhrases({ firstName })) {
    allowed.set(norm(phrase), "backchannel");
  }
  const turns = session?.aiInterview?.turns || [];
  for (const turn of turns) {
    // The grounded acknowledgement lives on the CANDIDATE's answer turn, not on an interviewer
    // turn — deliberately, because it is not part of the instrument and must never be read as an
    // interviewer question or reach askedQuestions (see utils/groundedAck.js). It is still spoken,
    // so it still has to be authorised, and it is authorised on exactly the terms everything else
    // here is: the engine wrote it, code verified it against the candidate's own transcript before
    // storing it, and it is now a stored fact about this session rather than a live model's
    // improvisation. Its own kind, so the divergence record can still distinguish it from a
    // question the candidate was asked.
    if (turn?.role === "candidate") {
      const ackText = turn?.ack?.text;
      if (ackText) {
        const key = norm(String(ackText).slice(0, MAX_SPEAK_CHARS));
        if (key) allowed.set(key, "grounded_ack");
      }
      continue;
    }
    if (turn?.role !== "ai") continue;
    if (turn.text) {
      const key = norm(String(turn.text).slice(0, MAX_SPEAK_CHARS));
      if (key) allowed.set(key, turn.kind || "question");
    }
    // The recruiter-approved plain-language rewording of this question, read to a candidate who
    // said they did not understand it. It is speakable for the same reason the question is —
    // a human approved this exact wording for this exact question and froze it — and it is
    // recognised as its own kind so "which version did this candidate actually hear?" stays
    // answerable from the divergence record.
    if (turn.restatement) {
      const key = norm(String(turn.restatement).slice(0, MAX_SPEAK_CHARS));
      if (key) allowed.set(key, "restatement");
    }
  }
  return allowed;
}

// Returns { authorized, kind, spoken } where `kind` names what it was recognised as.
function authorize(text, session) {
  const spoken = norm(String(text == null ? "" : text).slice(0, MAX_SPEAK_CHARS));
  if (!spoken) return { authorized: false, kind: null, spoken };
  const kind = allowedFor(session).get(spoken);
  return { authorized: Boolean(kind), kind: kind || null, spoken };
}

// Enforcement is on by default. The allowed set is precisely what this server itself produced, so a
// mismatch is a bug or tampering, never a legitimate variation — and refusing is not adverse to the
// candidate: the question is already on their screen to read, and typing answers is always
// available. Set VOICE_SPEECH_STRICT=false to record divergences without blocking, which is for
// diagnosing an unexpected mismatch, not for running that way.
function isEnforcing() {
  return process.env.VOICE_SPEECH_STRICT !== "false";
}

// How many divergences to keep on a session. A bug would produce one per turn, and the first few
// are the ones that identify it; the count is what matters after that.
const DIVERGENCE_TAIL = 20;

module.exports = { authorize, norm, isEnforcing, allowedFor, MAX_SPEAK_CHARS, DIVERGENCE_TAIL };
