// Event-anchored evidence clips (BUILD-PLAN Phase 14). The inversion of the
// proctoring-vendor posture: the browser keeps a short rolling buffer in
// memory and a clip is persisted ONLY when a high-severity proctoring event
// fires — consent-gated, hard-capped per session, auto-purged with the
// candidate. Evidence, not footage.
//
// Guardrails owned here:
//   - the per-session clip cap is enforced SERVER-side (client caps advisory);
//   - uploads are magic-byte checked (webm/mp4) — the claimed MIME is ignored;
//   - no consent → no stored clip, ever (the client also never buffers);
//   - clips are for human review only. Nothing in this file — or anywhere —
//     feeds a frame to an LLM or a scoring path.

const crypto = require("crypto");
const storageService = require("./storageService");
const ProctoringEvidence = require("../models/ProctoringEvidence");
const { NON_SCORING_TYPES: NON_SCORING_EVENTS } = require("../utils/proctoring");

const MAX_CLIPS_PER_SESSION = Number(process.env.EVIDENCE_MAX_CLIPS_PER_SESSION) || 6;
const MAX_CLIP_BYTES = 6 * 1024 * 1024; // multer also enforces this at ingest
const MAX_DURATION_MS = 25000; // ~15s buffer + assembly slack

// Only confirmed, reviewable moments justify persisting video. Every one of these is raised by the
// client's confirmation state machine after a condition has held continuously for its full window
// (see CONFIRM_TICKS in user/src/portal/useProctoring.js) — never on a single frame.
//
// "attention_pattern" is the behavioral exception: not a single event, but a cumulative
// ambient-noise pattern (repeated tab-switch/blur/right-click) crossing a threshold. Its clip is
// blurred client-side since a reviewer needs body language and context here, not identity.
//
// "detector_uncertain" is the epistemic exception, and the reason it is on this list at all: when
// our detector loses the candidate while already reading marginally, the clip is what lets a human
// SEE that the camera was dim or the candidate was far away. It carries zero risk weight — it
// exists to refute a flag, not to raise one.
const QUALIFYING_EVENTS = new Set([
  "multi_face",
  "identity_mismatch",
  "face_absent",
  "gaze_away",
  "detector_uncertain",
  "phone_cam_lost",
  "attention_pattern",
]);

// The measurement that justified a capture, travelling with the clip so a reviewer sees the claim
// and the evidence together. Strictly allow-listed and clamped: `rule` is the only string that
// survives and it is capped, because everything here renders into the admin report and the PDF.
const TRIGGER_NUMERIC_FIELDS = [
  "faceCount",
  "detectorScore",
  "lastDetectorScore",
  "lastFaceFrameRatio",
  "distance",
  "threshold",
];

function sanitizeTrigger(raw) {
  let input = raw;
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return undefined;
    }
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const out = {};
  if (typeof input.rule === "string" && input.rule.trim()) out.rule = input.rule.trim().slice(0, 160);
  if (input.direction === "down" || input.direction === "side") out.direction = input.direction;
  if (input.classified === "face_absent" || input.classified === "detector_uncertain") {
    out.classified = input.classified;
  }
  if (typeof input.lastFaceAtEdge === "boolean") out.lastFaceAtEdge = input.lastFaceAtEdge;
  for (const key of TRIGGER_NUMERIC_FIELDS) {
    const n = Number(input[key]);
    if (Number.isFinite(n)) out[key] = Math.round(n * 1000) / 1000;
  }
  return Object.keys(out).length ? out : undefined;
}

// WebM = EBML header; MP4 = "ftyp" brand at byte 4. Everything else is rejected
// regardless of the client-claimed content type.
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
function detectClipType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.subarray(0, 4).equals(WEBM_MAGIC)) return "video/webm";
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  return null;
}

// Fleet default comes from env (default OFF); a tenant can override either way
// via CompanySettings.proctoring. Off = exactly the pre-Phase-14 behaviour.
function clipsEnabled(companySettings) {
  const override = companySettings?.proctoring?.evidenceClips;
  if (typeof override === "boolean") return override;
  return process.env.EVIDENCE_CLIPS_ENABLED === "true";
}
function secondaryCamEnabled(companySettings) {
  const override = companySettings?.proctoring?.secondaryCam;
  if (typeof override === "boolean") return override;
  return process.env.SECONDARY_CAM_ENABLED === "true";
}

// Persist one uploaded clip. Throws a status-carrying error on any policy
// violation; the caller maps it straight to the response.
async function storeClip({ session, eventType, source, buffer, durationMs, trigger }) {
  if (!session.proctoring?.evidenceConsent?.given) {
    const err = new Error("Evidence-clip consent was not given for this session");
    err.status = 403;
    err.code = "EVIDENCE_CONSENT_REQUIRED";
    throw err;
  }
  if (!QUALIFYING_EVENTS.has(String(eventType))) {
    const err = new Error("This event type does not qualify for evidence capture");
    err.status = 400;
    throw err;
  }
  const mimeType = detectClipType(buffer);
  if (!mimeType) {
    const err = new Error("File content does not match a valid WebM or MP4 clip");
    err.status = 400;
    throw err;
  }
  if (buffer.length > MAX_CLIP_BYTES) {
    const err = new Error("Clip exceeds the size cap");
    err.status = 413;
    throw err;
  }

  // Server-enforced cap: the (cap+1)th upload is rejected no matter what the
  // client believes its own count is.
  const existing = await ProctoringEvidence.countDocuments({
    company: session.company,
    session: session._id,
  });
  if (existing >= MAX_CLIPS_PER_SESSION) {
    const err = new Error("Evidence clip cap reached for this session");
    err.status = 429;
    err.code = "EVIDENCE_CAP_REACHED";
    throw err;
  }

  const key = storageService.buildKey("evidence", {
    company: session.company,
    originalName: mimeType === "video/webm" ? "clip.webm" : "clip.mp4",
    prefix: String(eventType),
  });
  await storageService.putObject({ buffer, key, contentType: mimeType });

  const duration = Number.isFinite(Number(durationMs))
    ? Math.max(0, Math.min(MAX_DURATION_MS, Math.round(Number(durationMs))))
    : undefined;

  return ProctoringEvidence.create({
    company: session.company,
    session: session._id,
    candidate: session.candidate,
    job: session.job,
    eventType: String(eventType),
    source: source === "phone" ? "phone" : "laptop",
    clipKey: key,
    mimeType,
    sizeBytes: buffer.length,
    durationMs: duration,
    trigger: sanitizeTrigger(trigger),
    scored: !NON_SCORING_EVENTS.has(String(eventType)),
    sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
  });
}

// Purge every clip (rows + stored objects) for a candidate — called from
// candidatePurgeService so DPDP erasure and the nightly retention job both
// remove evidence footage with the candidate.
async function purgeForCandidate(companyId, candidateId) {
  const rows = await ProctoringEvidence.find({ company: companyId, candidate: candidateId }).select("clipKey");
  for (const row of rows) {
    try {
      await storageService.deleteObject(row.clipKey);
    } catch (err) {
      console.error(`[evidenceClip] failed to delete clip object ${row.clipKey}:`, err.message);
    }
  }
  const result = await ProctoringEvidence.deleteMany({ company: companyId, candidate: candidateId });
  return result?.deletedCount || 0;
}

module.exports = {
  MAX_CLIPS_PER_SESSION,
  MAX_CLIP_BYTES,
  QUALIFYING_EVENTS,
  sanitizeTrigger,
  detectClipType,
  clipsEnabled,
  secondaryCamEnabled,
  storeClip,
  purgeForCandidate,
};
