// Full-session interview recording, captured in the candidate's browser.
//
// This replaces LiveKit Egress (docs/INTERVIEW-RECORDING-MEDIARECORDER-PLAN.md). Egress recorded
// server-side and could only ever be COMPLETED by LiveKit Cloud calling our webhook — an external
// dashboard setting this repo does not control — so every recording that started sat at
// "recording" forever, while being billed as Egress output-minutes on top of the room-minutes we
// already pay for. Here the browser captures, uploads chunks as it goes, and our own finalize
// endpoint closes the row out. Nothing outside this system has to fire for a recording to exist.
//
// The pipeline is the one evidenceClipService already uses (browser MediaRecorder → multer →
// storageService.putObject), applied to the whole session instead of a triggered 15s segment.
//
// GUARDRAILS OWNED HERE — most of them are the same ones clips live under, for the same reasons:
//
//   - No consent → no recording, ever. And NOT the base proctoring consent: that clause promises
//     the candidate "raw video is not uploaded", and the clip clause promises "never recorded
//     continuously". A session recording contradicts both sentences, so it gets its own clause
//     (proctoring.recordingConsent) with its own accepted wording version and its own recorded
//     decline. The Egress path recorded under the base clause alone; that is not carried forward.
//   - Magic bytes decide the type. The client-claimed MIME is ignored, exactly like
//     detectAnswerAudioType and detectClipType.
//   - Caps are enforced SERVER-side: per-chunk bytes, per-session chunk count, and total bytes.
//     A valid portal token must not be usable to fill a bucket.
//   - `seq` is validated, not trusted: duplicates are rejected, so a replayed chunk cannot
//     silently overwrite a different part of the interview.
//   - NOTHING HERE IS SCORED. Not a frame, not a duration, not the fact that a recording is
//     missing. The recording plays next to the transcript for a human and is deleted with the
//     candidate; no evaluation path reads any field this file writes.

const storageService = require("./storageService");
const r2RecordingStorage = require("./r2RecordingStorage");

// One timeslice of video (see user/src/portal/useSessionRecorder.js: 45s at ~200 kbps
// ≈ 1.1MB). The cap is ~13× the expected size so a burst of motion, a high-DPI camera or a
// browser that flushes late still fits — it is a bound on abuse, not a quality target.
const MAX_CHUNK_BYTES = 15 * 1024 * 1024;

// A 45s timeslice for 2 hours is 160 chunks. 240 covers a long interview plus reconnect churn and
// still bounds a single session to a knowable worst case.
const MAX_CHUNKS_PER_SESSION = 240;

// The real ceiling. At the client's target bitrate a 40-minute interview is ~60MB, so this is
// generous by ~20×; it exists so that a client lying about its bitrate cannot turn one interview
// into unbounded storage.
const MAX_TOTAL_BYTES = 1200 * 1024 * 1024;

// MediaRecorder emits WebM in every browser that supports the codecs we ask for; Safari emits
// fragmented MP4. Both are accepted at ingest, but only WebM concatenates (see stitch below).
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
function detectChunkType(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer.subarray(0, 4).equals(WEBM_MAGIC)) return "video/webm";
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  return null;
}

// Fleet default from env (default OFF); a tenant can override either way via
// CompanySettings.ai.sessionRecording. Storage is a hard requirement rather than a preference:
// chunks have nowhere to go without it, and a recorder that runs and silently discards everything
// is worse than one that never starts, because the candidate consented to it.
//
// Deliberately NOT gated on the LiveKit pipeline. The browser holds the camera on every pipeline,
// so this works on the turn-based path too — which is the point of moving capture client-side.
function enabled(settings) {
  const override = settings?.ai?.sessionRecording;
  const wanted = typeof override === "boolean" ? override : process.env.CLIENT_RECORDING_ENABLED === "true";
  return wanted && storageService.isEnabled();
}

function statusError(message, status, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

function chunks(session) {
  return session.aiInterview?.recordingChunks || [];
}

// Persist one chunk. Throws a status-carrying error on any policy violation; the caller maps it
// straight to the response. Returns the sequence number actually stored.
async function storeChunk({ session, buffer, seq, durationMs, startedAt }) {
  if (!session.proctoring?.recordingConsent?.given) {
    throw statusError("Interview recording consent was not given for this session", 403, "RECORDING_CONSENT_REQUIRED");
  }
  const mimeType = detectChunkType(buffer);
  if (!mimeType) {
    throw statusError("File content does not match a valid WebM or MP4 chunk", 400);
  }
  if (buffer.length > MAX_CHUNK_BYTES) {
    throw statusError("Chunk exceeds the size cap", 413);
  }

  const ai = session.aiInterview || {};
  const existing = ai.recordingChunks || [];
  if (existing.length >= MAX_CHUNKS_PER_SESSION) {
    throw statusError("Recording chunk cap reached for this session", 429, "RECORDING_CAP_REACHED");
  }
  const totalBytes = existing.reduce((sum, c) => sum + (c.bytes || 0), 0);
  if (totalBytes + buffer.length > MAX_TOTAL_BYTES) {
    throw statusError("Recording size cap reached for this session", 429, "RECORDING_CAP_REACHED");
  }

  const n = Number(seq);
  if (!Number.isInteger(n) || n < 0 || n >= MAX_CHUNKS_PER_SESSION) {
    throw statusError("seq must be a chunk index within range", 400);
  }
  // A resent chunk is refused rather than allowed to overwrite. Uploads are fire-and-forget from
  // the browser, so a retry after a timeout that actually SUCCEEDED is a normal event — and
  // accepting it would leave two objects claiming the same position in the interview, one of which
  // the stitch would drop arbitrarily.
  if (existing.some((c) => c.seq === n)) {
    throw statusError("That chunk has already been uploaded", 409, "RECORDING_CHUNK_DUPLICATE");
  }

  const key = storageService.buildKey("interview-recording", {
    company: session.company,
    originalName: mimeType === "video/webm" ? "chunk.webm" : "chunk.mp4",
    prefix: `${session._id}-c${n}`,
  });
  await storageService.putObject({ buffer, key, contentType: mimeType });

  const duration = Number.isFinite(Number(durationMs)) ? Math.max(0, Math.round(Number(durationMs))) : undefined;
  existing.push({ key, seq: n, durationMs: duration, bytes: buffer.length, at: new Date() });

  session.aiInterview = ai;
  ai.recordingChunks = existing;
  ai.recordingStatus = "recording";
  ai.recordingSource = "client";
  // The capture clock, taken from the FIRST chunk only. This is what lets the report map a turn's
  // wall-clock time onto an offset in the video instead of guessing from the interview's start.
  // A later chunk cannot move it: the origin is a fact about when capture began, and a client that
  // could rewrite it could shift every timestamp in the reviewed recording.
  if (!ai.recordingStartedAt) {
    const stamped = startedAt ? new Date(startedAt) : null;
    const valid = stamped && !Number.isNaN(stamped.getTime());
    // Clamped to sane bounds: a clock-skewed or hostile client must not be able to claim capture
    // began before the interview did, or in the future. Outside the window we fall back to the
    // arrival time of the first chunk, which is late by at most one timeslice.
    const floor = session.startedAt ? new Date(session.startedAt).getTime() : 0;
    const now = Date.now();
    ai.recordingStartedAt = valid && stamped.getTime() >= floor && stamped.getTime() <= now ? stamped : new Date();
  }
  session.markModified("aiInterview");
  await session.save();
  return { seq: n, key };
}

// WebM chunks from ONE continuous MediaRecorder session share a single initialization segment
// (emitted with the first chunk), so appending the raw bytes in order yields a file players read
// as one clip. This is only true within a single recorder session — which is exactly what the
// client produces, and why a reconnect starts a new recording rather than resuming this one.
//
// MP4 (Safari) does not have this property. Those chunks are kept and the row lands at "partial":
// the footage exists and is retrievable, we just cannot claim a single playable file.
function canConcatenate(list) {
  return list.every((c) => !c.key.endsWith(".mp4"));
}

// Close out the recording: order the chunks, join them into one object, point `recordingKey` at
// it, and delete the parts. Idempotent — a second call on a completed row is a no-op, because
// finalize has three plausible callers (the interview's own end, the tab-close beacon, and a
// candidate who reloads) and none of them may produce a second stitched object.
async function finalize({ session, durationMs }) {
  const ai = session.aiInterview || {};
  if (ai.recordingStatus === "completed") return { status: "completed", already: true };

  const list = [...chunks(session)].sort((a, b) => a.seq - b.seq);
  if (!list.length) {
    // Nothing arrived. This is the honest "failed": the tenant had recording on, the candidate
    // consented, and there is no footage — which a reviewer should see said plainly rather than
    // discover as an empty player.
    ai.recordingStatus = "failed";
    ai.recordingSource = "client";
    session.aiInterview = ai;
    session.markModified("aiInterview");
    await session.save();
    return { status: "failed", chunks: 0 };
  }

  // Duration comes from the chunks we actually hold, not from the client's claim, and not from
  // wall-clock. A lost chunk must shorten the reported duration — a recording that says 40:00 and
  // plays 31:00 invites a reviewer to believe the missing nine minutes were never spoken.
  const summed = list.reduce((sum, c) => sum + (c.durationMs || 0), 0);
  const claimed = Number(durationMs);
  ai.recordingDurationMs = summed || (Number.isFinite(claimed) ? Math.max(0, Math.round(claimed)) : undefined);

  let status = "partial";
  if (canConcatenate(list)) {
    try {
      const buffers = [];
      for (const c of list) buffers.push(await storageService.getObjectBuffer(c.key));
      const key = storageService.buildKey("interview-recording", {
        company: session.company,
        originalName: "interview.webm",
        prefix: String(session._id),
      });
      await storageService.putObject({ buffer: Buffer.concat(buffers), key, contentType: "video/webm" });
      ai.recordingKey = key;
      status = "completed";

      // Only now are the parts redundant. Deletion is best-effort and deliberately AFTER the
      // stitched object is durable: an orphaned chunk costs storage, a chunk deleted before its
      // replacement exists costs the interview.
      for (const c of list) {
        try {
          await storageService.deleteObject(c.key);
        } catch (err) {
          console.error(`[interviewRecording] failed to delete chunk ${c.key}:`, err.message);
        }
      }
      ai.recordingChunks = [];
    } catch (err) {
      // The footage is uploaded and intact; only assembly failed. "failed" would tell a reviewer
      // nothing was recorded, which is false — and would make a retry look pointless.
      console.error(`[interviewRecording] stitch failed for session ${session._id}:`, err.message);
      status = "partial";
    }
  }

  ai.recordingStatus = status;
  ai.recordingSource = "client";
  session.aiInterview = ai;
  session.markModified("aiInterview");
  await session.save();
  return { status, chunks: list.length, durationMs: ai.recordingDurationMs };
}

// A short-lived URL the admin app hands straight to a <video> element — Range-capable, never
// buffered through this process. Returns null when there is nothing playable, which the caller
// renders as "no recording" rather than an error. A "partial" row deliberately returns null: the
// chunks exist, but there is no single file to play and pretending otherwise would hand the
// reviewer a broken player instead of an explanation.
async function playbackUrl(session) {
  return (await playbackDetails(session)).url;
}

function canPlay(session) {
  const ai = session?.aiInterview;
  if (!ai?.recordingKey) return false;
  return ai.recordingStatus === "completed" ||
    (r2RecordingStorage.isR2Recording(ai) && (ai.recordingSource === "egress" || ai.egressId) && ["recording", "pending"].includes(ai.recordingStatus));
}

function needsRecovery(session) {
  const ai = session?.aiInterview;
  return Boolean(ai?.egressId && !ai.recordingKey);
}

async function playbackOptions(session) {
  if (!needsRecovery(session)) return [];
  return (await r2RecordingStorage.filesForSession(session)).map(({ id, recordedAt }) => ({ id, recordedAt }));
}

async function playbackDetails(session, fileId) {
  if (needsRecovery(session)) {
    const files = await r2RecordingStorage.filesForSession(session);
    const selected = fileId ? files.find(file => file.id === fileId) : files.length === 1 ? files[0] : null;
    if (!selected) throw Object.assign(new Error("Choose a recording file for this interview."), { status: files.length ? 409 : 404 });
    return r2RecordingStorage.playback(selected.key);
  }
  if (!canPlay(session)) return { url: null };
  const ai = session.aiInterview;
  if (r2RecordingStorage.isR2Recording(ai)) return r2RecordingStorage.playback(ai.recordingKey);
  return { url: await storageService.getSignedDownloadUrl(ai.recordingKey, { expiresInSeconds: 900 }) };
}

async function storedKeysForDeletion(session) {
  const keys = storedKeys(session);
  if (needsRecovery(session)) keys.push(...(await r2RecordingStorage.filesForSession(session)).map(file => file.key));
  return [...new Set(keys)];
}

async function deleteStoredObject(session, key) {
  if (r2RecordingStorage.isR2Recording({ ...session.aiInterview, recordingKey: key })) {
    return r2RecordingStorage.deleteRecording(key);
  }
  return storageService.deleteObject(key);
}

// Every stored object this service can produce, for one session — the stitched file AND any
// chunks still lying around (a "partial" row, or a stitch whose cleanup pass died). Used by
// candidatePurgeService so DPDP erasure and the nightly retention job remove interview footage
// with the candidate. This is also the fix for a real gap: the Egress path wrote `recordingKey`
// and nothing ever deleted it, so erasing a candidate left their interview video in the bucket.
function storedKeys(session) {
  const ai = session?.aiInterview;
  if (!ai) return [];
  const keys = (ai.recordingChunks || []).map((c) => c.key).filter(Boolean);
  if (ai.recordingKey) keys.push(ai.recordingKey);
  return keys;
}

module.exports = {
  MAX_CHUNK_BYTES,
  MAX_CHUNKS_PER_SESSION,
  MAX_TOTAL_BYTES,
  detectChunkType,
  enabled,
  storeChunk,
  finalize,
  playbackUrl,
  playbackDetails,
  canPlay,
  playbackOptions,
  storedKeysForDeletion,
  deleteStoredObject,
  storedKeys,
};
