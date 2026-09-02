// The end of the interview: the capstone experience question, and the two easy ones after it.
//
// WHY THESE ARE AUTHORED IN CODE AND NOT GENERATED. They are asked of every candidate for every
// role, so they are part of the instrument, and every part of the instrument has to be identical
// across candidates to be comparable. Generating "which project have you worked on the most?"
// per candidate would produce eight slightly different questions and no way to compare the eight
// answers. These are constants, versioned with the file, and a reviewer can read exactly what was
// asked. Same rule as aiInterviewService.openingScript.
//
// ---------------------------------------------------------------------------
// The capstone
// ---------------------------------------------------------------------------
//
// "Which project or technology have you worked on the most?", then "what was your role and what
// were the main challenges?" — asked near the end, deliberately.
//
// What makes it worth a slot: every other question in the interview is chosen by the recruiter or
// by a probe, which means the interview only ever tests what someone thought to ask about. This
// one hands the candidate the choice of ground. A candidate who has spent the interview looking
// average on the approved set and then comes alive describing the thing they actually built is a
// candidate the approved set mismeasured — and that is a signal the instrument cannot produce on
// its own, because the instrument does not know what it left out.
//
// It goes LAST rather than first for two reasons. Asked first, it anchors the whole interview on
// whatever the candidate nominates, and the approved questions afterwards get answered as
// footnotes to it. Asked last, the recruiter's instrument has already run clean, and the answer
// is a comparison point against it rather than a frame around it.
//
// It is asked in TWO turns, not one. "Which have you worked on most, and what was your role, and
// what were the challenges?" is three questions in one breath — a candidate answers the last part
// and forgets the rest, and the ones who suffer most are the ones with the most to say. The
// second turn also has a property the rest of the interview does not: it is grounded in whatever
// they just nominated, without a model needing to compose anything, because "that one" refers to
// their own choice.
//
// ---------------------------------------------------------------------------
// The closers
// ---------------------------------------------------------------------------
//
// Two easy conversational questions at the very end. Their purpose is partly humane — an
// interview that ends on the hardest question of the set ends with the candidate feeling they
// failed it, whatever the transcript says — and partly measurement: what someone volunteers when
// the pressure is off is often the most honest thing they say about what they actually do.
//
// They are SCORED LIKE ANY OTHER ANSWER but they are marked `easy`, and nothing in the rubric
// depends on them. That combination is deliberate: excluding them from scoring entirely would
// mean discarding evidence a candidate freely gave, while weighting them like a competency
// question would mean rating someone on their taste in tools.
//
// WHAT THEY ARE NOT: they are not a personality test, not a culture-fit probe, and not an
// icebreaker about the candidate's life. Every one of them is about WORK — the technology, the
// project, the skill. "What do you do for fun?" is the version of this that ends up asking about
// religion, family and disability by accident, so it is not here and must not be added.

// Bump when any wording below changes: a stored interview records which version of the closing
// sequence it ran, so "what was this candidate asked?" stays answerable from the transcript alone.
const CLOSING_SCRIPT_VERSION = "2026-08-17.1";

// ---------------------------------------------------------------------------
// The capstone pair
// ---------------------------------------------------------------------------

// Phrased to work for any role, because the interview is not necessarily a technical one (see
// utils/followUpPrompts.interviewerSystemFor for the same correction). "Project, product or area
// of work" covers a marketing campaign, a finance close, a clinical study and a service migration
// without naming any of them.
const CAPSTONE_PRIMARY =
  "Thinking about everything you've worked on, and what this role involves — which project, " +
  "product or area of work have you spent the most time on?";

// Asked as the next turn, after they have named something. "That one" is grounded in their own
// answer by construction, so this needs no model and no per-candidate composition.
const CAPSTONE_FOLLOW =
  "Could you tell me a bit more about that one — what your own role was, and what the main " +
  "challenges were that you worked on?";

// ---------------------------------------------------------------------------
// The closers
// ---------------------------------------------------------------------------

// Rotated by session so the interview does not end identically for everyone in a way that gets
// posted and rehearsed, but drawn from a fixed, reviewable bank — the same trade-off
// utils/backchannel.js makes, and rotated deterministically for the same reason: what a given
// candidate was asked has to be reproducible from the stored index.
const CLOSERS = [
  "Last couple of easy ones. Which part of the work you've described did you most enjoy doing?",
  "Nearly done — what's one skill you'd like to get better at over the next year or so?",
  "Just a couple of easy ones to finish. What kind of work do you enjoy most day to day?",
  "Almost there — of everything you've worked with, what would you happily use again?",
  "One easy one to finish on. What's something you'd like to learn more about in this kind of role?",
  "Last easy one. Which part of a project do you usually enjoy most — the start, the middle, or finishing it off?",
];

// How many closers are asked. Two, per the spec, and bounded here rather than at the call site so
// the count is part of the versioned script rather than a caller's choice.
const CLOSER_COUNT = Number(process.env.INTERVIEW_CLOSER_COUNT || 2);

// Deterministic, non-repeating selection. `seed` is a stable per-session integer (the session id's
// digits, in practice) so the same interview always yields the same closers on replay, and two
// candidates in the same batch do not all get the same pair.
function closersFor(seed = 0, count = CLOSER_COUNT) {
  const n = Math.max(0, Math.min(count, CLOSERS.length));
  const start = Math.abs(Math.trunc(Number(seed) || 0)) % CLOSERS.length;
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(CLOSERS[(start + i) % CLOSERS.length]);
  return out;
}

// The full closing sequence, in the order it is asked. Callers append this to the interview once
// the approved set and every claim-probe are covered — never before, because a closing sequence
// that ran while an approved question was still pending would mean the interview ended without
// running the instrument the recruiter designed.
function closingSequence({ seed = 0, includeCapstone = true, closerCount = CLOSER_COUNT } = {}) {
  const seq = [];
  if (includeCapstone) {
    seq.push({ text: CAPSTONE_PRIMARY, kind: "capstone", difficulty: "medium", topic: "strongest experience" });
    seq.push({ text: CAPSTONE_FOLLOW, kind: "capstone_follow", difficulty: "medium", topic: "strongest experience" });
  }
  for (const text of closersFor(seed, closerCount)) {
    seq.push({ text, kind: "closer", difficulty: "easy", topic: "wrap-up" });
  }
  return seq;
}

// Kinds that are part of the closing sequence. Used by the report and the scorer to label them —
// a reviewer reading "easy" beside the last two answers needs to know that was the design, not a
// model deciding this candidate deserved easier questions.
const CLOSING_KINDS = new Set(["capstone", "capstone_follow", "closer"]);

module.exports = {
  CLOSING_SCRIPT_VERSION,
  CAPSTONE_PRIMARY,
  CAPSTONE_FOLLOW,
  CLOSERS,
  CLOSER_COUNT,
  CLOSING_KINDS,
  closersFor,
  closingSequence,
};
