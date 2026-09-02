// Saying the candidate's name correctly.
//
// STATUS (2026-08-18): the ASK is RETIRED by owner decision — aiInterviewService no longer
// inserts a name_check turn, so nothing reaches fromSelfReport for new sessions. The module
// stays because (a) sessions recorded before the retirement carry respellings that applyTo
// must keep rendering, and (b) a session that was mid-name-check at deploy time still routes
// its answer through recordNamePronunciation. Do not delete without checking both.
//
// THE FAILURE THIS FIXES. The interviewer greets the candidate by name, says it a few times during
// the interview (utils/backchannel's `{name}` phrases), and says it again in the closing. A
// text-to-speech engine given "Vijendra" applies English letter-to-sound rules and produces
// something the candidate does not recognise as their own name — then repeats it eight times over
// twenty minutes. Candidates report this, correctly, as the single most alienating thing about the
// experience, and it lands overwhelmingly on people whose names are not Anglo-European. A hiring
// tool that mispronounces exactly those candidates' names, every time, is not a cosmetic problem.
//
// THE APPROACH: ASK. Not infer. There is a large literature of name-to-pronunciation heuristics
// and all of them are wrong about somebody — often about people who share a spelling and not a
// pronunciation, which is most of the interesting cases. The candidate is right there and knows
// the answer, so the interview spends one turn asking, exactly as a human interviewer does.
//
// WHY THE ANSWER IS THEN VERIFIED IN CODE. What comes back is a speech transcript, and the thing
// we would do with it is put a new string into the interviewer's mouth. Two ways that goes wrong:
// the transcript is of someone saying something else entirely (they misheard the question and
// introduced themselves), or the respelling we derive is phonetically nothing like their name, in
// which case we have replaced one mispronunciation with a worse and more confident one. So a
// candidate respelling is only adopted when it is PLAUSIBLY THE SAME NAME (isPlausibleFor below),
// and otherwise we abstain and say the name as written — the current behaviour, so a failure here
// can never be worse than not having the feature.
//
// WHY THIS DOES NOT WEAKEN THE AUDIT TRAIL — the same argument as utils/speakable.js, which this
// sits beside. The candidate's name as recorded on their application stays the record. This is a
// RENDERING step between the approved text and the sound waves: a pure function of (authored text,
// stored respelling), so what a candidate heard is reconstructible from what is already stored.
// Nothing here reaches a score, and nothing here may ever be read as evidence about the candidate.
// How someone pronounces their own name correlates with national origin and with nothing else
// whatsoever, so it is recorded as a rendering parameter and is structurally excluded from every
// scoring path — the same treatment utils/repeatIntent gives the repeat count, for the same reason.

// Bump when the asked wording changes — it is part of the instrument every candidate hears.
const PRONUNCIATION_SCRIPT_VERSION = "2026-08-17.1";

// Asked once, immediately after the greeting and before the first question. Phrased as a request
// for help rather than a test of the candidate, and it explicitly permits the short answer, because
// "how do you say your name?" otherwise reads as an invitation to explain your heritage — which is
// a conversation about national origin that this interview must not have.
const PRONUNCIATION_ASK =
  "Before we begin — I'd like to make sure I say your name properly. Could you say it for me?";

// NOTE — deliberately no confirmation phrase here, and no "did I get that right?". Reading the name
// back invites a candidate to be polite about a wrong attempt, which produces a confidently wrong
// respelling; and it makes someone audition their own name for a machine. The warmup question
// follows immediately, which is acknowledgement enough.

// A candidate who cannot be understood twice is not asked a third time. Their name is then said as
// written, which is exactly what happens today.
const MAX_ATTEMPTS = 2;

// ---------------------------------------------------------------------------
// Phonetic plausibility
// ---------------------------------------------------------------------------
//
// The question this answers is narrow and it is not "is this the correct pronunciation" — we have
// no way to know that and the candidate is the only authority. It is "could this plausibly be a
// respelling of THIS name, rather than a different name or a transcription of something else?"
// That is enough to catch the failure modes that matter: the candidate answered a different
// question, the transcript is garbage, or a model substituted a name it found more familiar.

// Digraphs first (longest-first application matters: "sch" before "sh" before "s"), mapped to a
// single representative sound. Deliberately coarse — this is a similarity test, not a phonemiser.
const DIGRAPHS = [
  ["sch", "s"], ["tch", "c"], ["ph", "f"], ["sh", "s"], ["zh", "j"], ["ch", "c"],
  ["th", "t"], ["kh", "k"], ["gh", "g"], ["ck", "k"], ["qu", "k"], ["ts", "s"],
  ["dj", "j"], ["dh", "d"], ["bh", "b"], ["jh", "j"], ["ng", "n"],
];

// Single letters that share a sound often enough that treating them as distinct would reject
// correct respellings. x→s covers the Mandarin romanisation ("Xiaoling" → "shao-ling"); c→k and
// z→s are the usual English ambiguities; v→b and w→v appear across South Asian and East Asian
// respellings routinely.
const LETTERS = { x: "s", z: "s", k: "k", c: "k", q: "k", v: "b", w: "b", f: "f", j: "j" };

// Reduce a name (or a respelling of one) to a coarse consonant skeleton. Vowels go entirely:
// vowel choice is exactly what a respelling is FOR, so comparing on vowels would reject every
// useful answer. h/y also go — they are the commonest respelling padding ("vih-", "-yah").
function phoneticSkeleton(input) {
  let s = String(input || "").toLowerCase().replace(/[^a-z]+/g, "");
  if (!s) return "";
  for (const [from, to] of DIGRAPHS) s = s.split(from).join(to);
  s = s
    .split("")
    .map((ch) => LETTERS[ch] || ch)
    .join("");
  s = s.replace(/[aeiouhy]/g, "");
  // Collapse runs: a respelling doubles consonants for stress ("vij-JEN-dra") and the written
  // form usually does not.
  s = s.replace(/(.)\1+/g, "$1");
  return s;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[b.length];
}

// How far apart two skeletons may be. Scaled to length, because one substitution in a
// three-consonant name is a different name while one in an eight-consonant name is a spelling
// preference. The floor of 1 lets short names absorb a single difference.
function allowedDistance(skeletonLength) {
  return Math.max(1, Math.floor(skeletonLength / 3));
}

// Words that are never someone volunteering their name, however well their consonants happen to
// line up. In a real session the candidate's "No." — an answer to a different, improvised
// question — passed the skeleton test against a short recorded name (both reduce to one
// consonant, and one edit is allowed), and "No" was stored as how to say their name. The
// skeleton test asks "could these be the same sounds?"; it cannot ask "is this an answer to the
// question at all?", so that check lives here.
const NOT_A_NAME_RE =
  /^(?:no|nope|nah|yes|yeah|yep|ok|okay|sure|what|why|when|where|how|who|sorry|pardon|hello|hi|hey|please|stop|wait|done|fine|good|great|right|correct|next|skip|pass|nothing|none|again|repeat|huh|hmm+|um+|uh+|er+|ah+)$/i;

// Could `respelling` plausibly be a respelling of `name`? Both are reduced to skeletons and
// compared. Returns a decision plus the numbers, so a rejection is explainable in a log rather
// than a mystery.
function isPlausibleFor(respelling, name) {
  const a = phoneticSkeleton(respelling);
  const b = phoneticSkeleton(name);
  if (!a || !b) return { plausible: false, distance: null, allowed: null, reason: "no_skeleton" };
  // A one-consonant skeleton carries almost no signal, so the usual "absorb one difference"
  // allowance turns it into a wildcard — "No" (→ n) sits within one edit of any short name.
  // When either side is that short, only an exact skeleton match counts.
  const allowed =
    Math.min(a.length, b.length) <= 1 ? 0 : allowedDistance(Math.max(a.length, b.length));
  const distance = levenshtein(a, b);
  if (distance > allowed) {
    return { plausible: false, distance, allowed, reason: "too_different" };
  }
  return { plausible: true, distance, allowed, reason: null };
}

// ---------------------------------------------------------------------------
// Reading what the candidate said
// ---------------------------------------------------------------------------

// Filler the candidate wraps the answer in. Stripped before looking for the name, so "yeah sure,
// it's Vijendra" yields "Vijendra" and not "yeah sure it's Vijendra".
const LEAD_IN_RE =
  /^\s*(?:um+|uh+|er+|ah+|so|ok(?:ay)?|yeah|yes|sure|of course|right|well|hi|hello)\b[\s,.]*/i;
const CARRIER_RE =
  /\b(?:it'?s|its|i'?m|i am|my name is|my name'?s|you can call me|they call me|call me|the name'?s|that'?s)\b/i;

// A hyphenated or slashed respelling the candidate volunteered — "it's vih-JEN-dra" — is the best
// possible input and is taken as-is. Requires at least one separator and two syllable chunks, so
// an ordinary hyphenated surname ("Smith-Jones") is not mistaken for a respelling of a first name.
const EXPLICIT_RESPELLING_RE = /\b([A-Za-z]{1,10}(?:[-–/][A-Za-z]{1,10}){1,5})\b/;

/**
 * Derive a usable respelling from what the candidate said when asked how to say their name.
 *
 * Returns { respelling, source, plausibility } or null when nothing usable was found. `source` is
 * "explicit" when they respelled it themselves and "asr" when we are using the transcriber's own
 * spelling of the sounds they made — a weaker but real signal, since a transcriber that heard
 * "Bijendra" is telling us something about the first consonant.
 *
 * @param {string} transcript what they said
 * @param {string} name       the name as recorded on the application
 */
function fromSelfReport(transcript, name) {
  const raw = String(transcript || "").trim();
  if (!raw || !String(name || "").trim()) return null;

  let text = raw.replace(LEAD_IN_RE, "");
  const carrier = CARRIER_RE.exec(text);
  if (carrier) text = text.slice(carrier.index + carrier[0].length);
  text = text.replace(/^[\s,.:—-]+/, "").trim();
  if (!text) return null;

  // Prefer an explicit respelling anywhere in the answer.
  const explicit = EXPLICIT_RESPELLING_RE.exec(text);
  if (explicit) {
    const candidate = explicit[1];
    if (!NOT_A_NAME_RE.test(candidate)) {
      const plausibility = isPlausibleFor(candidate, name);
      if (plausibility.plausible) {
        return { respelling: candidate, source: "explicit", plausibility };
      }
    }
  }

  // Otherwise take the leading word or two as the transcriber's rendering of the name. Bounded at
  // two words because a first name is one or two tokens and everything after that is commentary.
  const words = text.split(/\s+/).filter(Boolean).slice(0, 2);
  for (const attempt of [words.slice(0, 2).join(" "), words[0]]) {
    if (!attempt) continue;
    const cleaned = attempt.replace(/[^A-Za-z'-]+/g, "");
    if (cleaned.length < 2) continue;
    if (NOT_A_NAME_RE.test(cleaned)) continue;
    const plausibility = isPlausibleFor(cleaned, name);
    if (plausibility.plausible) {
      return { respelling: cleaned, source: "asr", plausibility };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Substitute the stored respelling for the candidate's name in text about to be spoken.
 *
 * Runs AFTER speechAuthorization has approved the authored text and alongside speakable.toSpeakable
 * — it is a pronunciation step, so it must never be the thing that decides what may be said.
 * Whole-word, case-insensitive; returns the input untouched when there is no respelling, so every
 * caller can apply it unconditionally.
 */
function applyTo(text, name, respelling) {
  const source = String(text == null ? "" : text);
  const target = String(name || "").trim();
  const replacement = String(respelling || "").trim();
  if (!target || !replacement) return { text: source, applied: false };
  const re = new RegExp("\\b" + escapeRe(target) + "\\b", "gi");
  if (!re.test(source)) return { text: source, applied: false };
  return { text: source.replace(re, replacement), applied: true };
}

module.exports = {
  PRONUNCIATION_SCRIPT_VERSION,
  PRONUNCIATION_ASK,
  MAX_ATTEMPTS,
  NOT_A_NAME_RE,
  DIGRAPHS,
  LETTERS,
  phoneticSkeleton,
  allowedDistance,
  isPlausibleFor,
  fromSelfReport,
  applyTo,
};
