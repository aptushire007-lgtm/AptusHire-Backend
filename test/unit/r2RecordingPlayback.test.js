const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { S3Client } = require("@aws-sdk/client-s3");
const r2 = require("../../services/r2RecordingStorage");
const recording = require("../../services/interviewRecordingService");
const Session = require("../../models/InterviewSession");
const AuditLog = require("../../models/AuditLog");
const { getRecordingUrl } = require("../../controllers/interviewSessionController");

const originals = { send: S3Client.prototype.send, findOne: Session.findOne, audit: AuditLog.create, playback: r2.playback };
const envNames = ["R2_ENDPOINT", "R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];
const oldEnv = Object.fromEntries(envNames.map(k => [k, process.env[k]]));
afterEach(() => {
  S3Client.prototype.send = originals.send; Session.findOne = originals.findOne;
  AuditLog.create = originals.audit; r2.playback = originals.playback;
  for (const k of envNames) { if (oldEnv[k] == null) delete process.env[k]; else process.env[k] = oldEnv[k]; }
});
function configure() {
  Object.assign(process.env, { R2_ENDPOINT: "https://account.r2.cloudflarestorage.com", R2_BUCKET: "recordings", R2_ACCESS_KEY_ID: "test-access", R2_SECRET_ACCESS_KEY: "test-secret" });
}

test("private R2 playback signs the stored key with a 15-minute expiry and supports old key formats", async () => {
  configure();
  const heads = [];
  S3Client.prototype.send = async cmd => { heads.push(cmd.input); return { ContentLength: 2000 }; };
  for (const key of ["egress/session.mp4", "r2:egress/session.mp4", "s3://recordings/egress/session.mp4", "https://account.r2.cloudflarestorage.com/recordings/egress/session.mp4"]) {
    const result = await r2.playback(key);
    const url = new URL(result.url);
    assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
    assert.equal(url.searchParams.get("response-content-type"), "video/mp4");
    assert.equal(url.pathname, "/recordings/egress/session.mp4");
    assert.ok(result.expiresAt);
    assert.ok(!result.url.includes("test-secret"));
  }
  assert.deepEqual(heads[0], { Bucket: "recordings", Key: "egress/session.mp4" });
  assert.throws(() => r2.objectKey("s3://another-bucket/video.mp4"));
  assert.throws(() => r2.objectKey("https://untrusted.test/video.mp4"));
});

test("R2 references and historical browser keys remain distinct from Cloudinary; pending Egress can be checked", async () => {
  assert.equal(r2.isR2Recording({ recordingKey: "cloudinary:encoded", recordingSource: "egress" }), false);
  assert.equal(r2.isR2Recording({ recordingKey: "https://res.cloudinary.com/video.mp4", recordingSource: "client" }), false);
  assert.equal(r2.isR2Recording({ recordingKey: "recordings/client.webm", recordingSource: "client" }), true);
  const session = { aiInterview: { recordingKey: "egress/old.mp4", recordingSource: "egress", recordingStatus: "recording" } };
  r2.playback = async key => ({ url: `signed:${key}` });
  assert.equal(recording.canPlay(session), true);
  assert.equal(await recording.playbackUrl(session), "signed:egress/old.mp4");
  session.aiInterview.recordingStatus = "partial";
  assert.equal(await recording.playbackUrl(session), null);
});

test("missing, empty and unsupported R2 objects never yield a playable URL", async () => {
  configure();
  S3Client.prototype.send = async () => { throw Object.assign(new Error("missing"), { name: "NotFound" }); };
  await assert.rejects(r2.playback("egress/video.mp4"), { name: "NotFound" });
  S3Client.prototype.send = async () => ({ ContentLength: 0 });
  await assert.rejects(r2.playback("egress/video.mp4"), { status: 409 });
  S3Client.prototype.send = async () => ({ ContentLength: 100 });
  await assert.rejects(r2.playback("egress/playlist.m3u8"), { status: 422 });
});

test("recording erasure sends the R2 object to the correct bucket", async () => {
  configure();
  let deletion;
  S3Client.prototype.send = async cmd => { deletion = cmd; };
  await recording.deleteStoredObject({ aiInterview: { recordingSource: "egress" } }, "r2:egress/old.mp4");
  assert.equal(deletion.constructor.name, "DeleteObjectCommand");
  assert.deepEqual(deletion.input, { Bucket: "recordings", Key: "egress/old.mp4" });
});

test("missing Egress keys are recovered only within the owning session; multiple captures require a selection", async () => {
  configure();
  const session = { _id: "507f1f77bcf86cd799439011", company: "507f1f77bcf86cd799439022", aiInterview: { egressId: "EG_old", recordingStatus: "recording" } };
  const prefix = `interview-recordings/${session.company}/${session._id}-`;
  S3Client.prototype.send = async cmd => {
    assert.equal(cmd.constructor.name, "ListObjectsV2Command");
    assert.equal(cmd.input.Prefix, prefix);
    return { Contents: [
      { Key: `${prefix}1787508270128.mp4`, Size: 1000 },
      { Key: `${prefix}1787508270129.mp4`, Size: 2000 },
      { Key: `${prefix}1787508270129.mp4.json`, Size: 20 },
      { Key: "interview-recordings/another-tenant/video.mp4", Size: 2000 },
    ] };
  };
  const options = await recording.playbackOptions(session);
  assert.equal(options.length, 2);
  assert.ok(options.every(file => !file.key));
  await assert.rejects(recording.playbackDetails(session), { status: 409 });
  await assert.rejects(recording.playbackDetails(session, "unowned-file"), { status: 409 });
  r2.playback = async key => ({ url: `signed:${key}` });
  assert.equal((await recording.playbackDetails(session, options[1].id)).url, `signed:${prefix}1787508270129.mp4`);
  assert.deepEqual(await recording.storedKeysForDeletion(session), [`${prefix}1787508270128.mp4`, `${prefix}1787508270129.mp4`]);
});

test("session playback enforces company scope, never signs a browser-supplied key, and audits only issued URLs", async () => {
  const id = "507f1f77bcf86cd799439011";
  let filter, reads = 0, audits = 0, status = 200, body, cache;
  const session = { _id: id, aiInterview: { recordingStatus: "completed", recordingSource: "egress", recordingKey: "egress/owned.mp4" } };
  Session.findOne = f => { filter = f; return { select: async () => session }; };
  AuditLog.create = async () => { audits++; };
  r2.playback = async key => { reads++; assert.equal(key, "egress/owned.mp4"); return { url: "signed-url" }; };
  const req = { params: { sessionId: id }, query: { key: "egress/another-tenant.mp4" }, user: { company: "tenant" } };
  const res = { setHeader(k, v) { cache = [k, v]; }, status(code) { status = code; return this; }, json(data) { body = data; return this; } };
  await getRecordingUrl(req, res);
  assert.deepEqual(filter, { _id: id, company: "tenant" });
  assert.equal(body.url, null); assert.equal(reads, 0); assert.equal(audits, 0);
  assert.deepEqual(cache, ["Cache-Control", "no-store"]);
  req.query.mint = "1";
  await getRecordingUrl(req, res);
  assert.equal(body.url, "signed-url"); assert.equal(audits, 1);
  Session.findOne = () => ({ select: async () => null });
  await getRecordingUrl(req, res);
  assert.equal(status, 404); assert.equal(reads, 1); assert.equal(audits, 1);
  req.params.sessionId = "invalid";
  await getRecordingUrl(req, res);
  assert.equal(status, 400);
});
