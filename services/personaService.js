// Resolves which interviewer persona a session runs under, and records it.
//
// The persona decides the interviewer's name, voice and patience — never its questions (see
// models/PersonaProfile.js for why that line matters). Resolution order:
//
//   1. this tenant's approved PersonaProfile (highest version wins)
//   2. the deployment default below, labelled as such
//
// Every resolution is stamped onto the session, including which of those two it came from. That
// stamp is the point of the whole exercise: a decision defended months later needs to be able to
// state the conditions the candidate was interviewed under, and "the same warm patient
// interviewer as everyone else for this role" is one of them.

const PersonaProfile = require("../models/PersonaProfile");
const InterviewSession = require("../models/InterviewSession");
const backchannel = require("../utils/backchannel");
const repeatIntent = require("../utils/repeatIntent");
const endpointing = require("../utils/endpointing");
const finishIntent = require("../utils/finishIntent");
const echoAlignment = require("../utils/echoAlignment");
const conversationIntent = require("../utils/conversationIntent");
const dialogueActs = require("../utils/dialogueActs");
const intentPhraseService = require("./intentPhraseService");
const { PATIENCE_BOUNDS } = PersonaProfile;

// The deployment default, used when a tenant has approved no persona of its own. Deliberately
// marked `source: "default"` everywhere it surfaces rather than passed off as a tenant choice —
// the interviewer's voice and name measurably affect how candidates respond, so which one was
// used is a fact about the interview, not a cosmetic detail.
function defaultPersona() {
  return {
    key: "default",
    version: 0, // 0 = not a tenant-approved version
    name: process.env.VOICE_PERSONA_DEFAULT_NAME || "Ava",
    voice: {
      provider: process.env.VOICE_PERSONA_DEFAULT_PROVIDER || "deepgram",
      model: process.env.VOICE_PERSONA_DEFAULT_VOICE || "", // empty ⇒ the provider default voice
    },
    patience: {},
    source: "default",
  };
}

function clamp(value, bound) {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(bound.min, Math.min(bound.max, value));
}

// Clamped on read as well as validated on write: a persona approved before a bounds change, or
// edited around the model guard, must still not be able to make the interviewer impatient.
function normalizePatience(patience) {
  const out = {};
  for (const [field, bound] of Object.entries(PATIENCE_BOUNDS)) {
    const v = clamp(Number(patience?.[field]), bound);
    if (v !== undefined) out[field] = v;
  }
  return out;
}

function fromDoc(doc) {
  return {
    key: doc.key,
    version: doc.version,
    name: doc.name,
    voice: { provider: doc.voice?.provider || "deepgram", model: doc.voice?.model || "" },
    patience: normalizePatience(doc.patience),
    source: "tenant",
  };
}

async function resolveForSession(session) {
  if (!session?.company) return defaultPersona();
  try {
    const doc = await PersonaProfile.findOne({ company: session.company, status: "approved" })
      .sort({ version: -1 })
      .lean();
    return doc ? fromDoc(doc) : defaultPersona();
  } catch (err) {
    // A persona lookup failure must never cost a candidate their interview slot — fall back to
    // the deployment default, which is a fully working interviewer.
    console.error("[persona] resolution failed, using the deployment default:", err.message);
    return defaultPersona();
  }
}

// The conversational policy the browser gets: the code-resident phrase bank plus this tenant's
// patience. The WORDS never come from the persona (utils/backchannel.js owns those, checked at
// boot for evaluative language) — only how long the interviewer is willing to wait.
// `firstName` is the candidate's, and it is the only per-candidate value that ever reaches the
// phrase bank. It is permissible for one reason: it is fixed before the interview starts and
// cannot vary with how the candidate is doing, which is the test everything in this bank has to
// pass. A topic, a score, or anything characterising the last answer would fail it.
function conversationPolicy(persona, { firstName = "", approvedTriggers = null } = {}) {
  const base = {
    ...backchannel.clientPolicy({ firstName }),
    ...repeatIntent.clientPolicy(),
    // When a turn has ENDED (utils/endpointing) and when the candidate has said so outright
    // (utils/finishIntent). Both run in the browser because only it knows in real time, and both
    // are configured here so a tenant's interview conditions stay in one place.
    ...endpointing.clientPolicy(),
    ...finishIntent.clientPolicy(),
    // What the candidate can say ABOUT the interview rather than into it — declining a question,
    // asking for a moment, asking to stop (utils/dialogueActs.js). Same division of labour as
    // everything above: the browser detects, the server owns the rules and the wording, and the
    // server re-checks before any of it takes effect.
    ...dialogueActs.clientPolicy(),
    // Whether what the microphone just heard was the candidate or the interviewer's own voice
    // coming back (utils/echoAlignment.js). This is what lets the microphone stay open while the
    // interviewer speaks on EVERY device rather than only on the ones where a pre-check tone
    // measured good hardware echo cancellation.
    ...echoAlignment.clientPolicy(),
    // The closed set of things the candidate can want, and the gate the semantic tier's answers
    // have to pass (utils/conversationIntent.js). The browser runs the deterministic tier locally
    // because a live turn cannot wait on the network for the common case, and calls the server for
    // the semantic tier only when the deterministic one is silent.
    ...conversationIntent.clientPolicy(),
  };
  // This tenant's own approved phrasings, folded into the trigger lists. Additive by construction
  // (services/intentPhraseService.mergeIntoPolicy) — the built-in triggers cannot be removed, so
  // no tenant configuration can take away a candidate's ability to ask for a repeat or to stop.
  const withTenantPhrases = intentPhraseService.mergeIntoPolicy(base, approvedTriggers);
  const p = normalizePatience(persona?.patience);
  return {
    ...withTenantPhrases,
    maxReassurancesPerTurn:
      p.maxReassurancesPerTurn !== undefined && base.reassurances.length
        ? p.maxReassurancesPerTurn
        : base.maxReassurancesPerTurn,
    postReassuranceGraceMs: p.postReassuranceGraceMs ?? base.postReassuranceGraceMs,
    initialSilenceMs: p.initialSilenceMs ?? base.initialSilenceMs,
  };
}

// Record which persona this session ran under. Same shape of write as asrVocabularyService: a
// targeted $set rather than session.save(), because proctoring flushes save the same document
// concurrently and must not be clobbered. Idempotent — one stamp per session.
async function stampOnSession(session, persona) {
  try {
    const existing = session?.aiInterview?.persona;
    if (existing?.key === persona.key && existing?.version === persona.version) return;
    const stamp = {
      key: persona.key,
      version: persona.version,
      name: persona.name,
      voiceProvider: persona.voice.provider,
      voiceModel: persona.voice.model,
      source: persona.source,
      at: new Date(),
    };
    await InterviewSession.updateOne(
      { _id: session._id, company: session.company },
      { $set: { "aiInterview.persona": stamp } }
    );
    if (session.aiInterview) session.aiInterview.persona = stamp;
  } catch (err) {
    console.error("[persona] could not stamp the session:", err.message);
  }
}

// ---------------------------------------------------------------------------
// Authoring (admin) — draft → approve, never edit-in-place
// ---------------------------------------------------------------------------

function listForCompany(companyId) {
  return PersonaProfile.find({ company: companyId }).sort({ key: 1, version: -1 });
}

// A new draft always starts at (highest existing version + 1) for that key, so approving it
// supersedes rather than rewrites. An approved persona is frozen by the model itself; this is the
// only way to change one.
async function createDraft(companyId, input = {}) {
  const key = String(input.key || "default").trim().toLowerCase() || "default";
  const latest = await PersonaProfile.findOne({ company: companyId, key }).sort({ version: -1 }).select("version").lean();
  const doc = new PersonaProfile({
    company: companyId,
    key,
    version: (latest?.version || 0) + 1,
    status: "draft",
    name: String(input.name || "").trim(),
    voice: {
      provider: String(input.voice?.provider || "deepgram").trim(),
      model: String(input.voice?.model || "").trim(),
    },
    patience: normalizePatience(input.patience),
    notes: String(input.notes || "").trim(),
  });
  await doc.save();
  return doc;
}

async function updateDraft(id, companyId, input = {}) {
  const doc = await PersonaProfile.findOne({ _id: id, company: companyId });
  if (!doc) throw Object.assign(new Error("Persona not found"), { status: 404 });
  if (doc.status !== "draft") {
    // The model's frozen guard would reject this anyway; failing here gives a usable message.
    throw Object.assign(new Error("Only a draft persona can be edited — approve a new version instead"), { status: 400 });
  }
  if (input.name !== undefined) doc.name = String(input.name).trim();
  if (input.voice?.provider !== undefined) doc.voice.provider = String(input.voice.provider).trim();
  if (input.voice?.model !== undefined) doc.voice.model = String(input.voice.model).trim();
  if (input.patience !== undefined) doc.patience = normalizePatience(input.patience);
  if (input.notes !== undefined) doc.notes = String(input.notes).trim();
  await doc.save();
  return doc;
}

// Approval is the human-in-the-loop boundary, exactly as it is for a RoleRubric: a persona shapes
// the conditions every candidate is interviewed under, so it does not go live because code decided
// it should. Approving freezes this version and archives the one it replaces.
async function approve(id, companyId, user) {
  const doc = await PersonaProfile.findOne({ _id: id, company: companyId });
  if (!doc) throw Object.assign(new Error("Persona not found"), { status: 404 });
  if (doc.status === "approved") return doc;
  if (doc.status === "archived") {
    throw Object.assign(new Error("An archived persona cannot be re-approved — create a new draft"), { status: 400 });
  }
  if (!doc.name) throw Object.assign(new Error("A persona needs a name before it can be approved"), { status: 400 });

  const previous = await PersonaProfile.find({
    company: companyId,
    key: doc.key,
    status: "approved",
    _id: { $ne: doc._id },
  });

  doc.status = "approved";
  doc.frozenAt = new Date();
  doc.approvedBy = { user: user?._id, at: new Date() };
  await doc.save();

  // Load-modify-save, one at a time: query-level updates are banned on this collection so the
  // frozen guard always sees the change (status → archived is the one edit it permits).
  for (const old of previous) {
    old.status = "archived";
    await old.save();
  }
  return doc;
}

module.exports = {
  defaultPersona,
  resolveForSession,
  conversationPolicy,
  normalizePatience,
  stampOnSession,
  listForCompany,
  createDraft,
  updateDraft,
  approve,
};
