// Encrypted per-tenant board-credential store (Phase 15.5).
//
// Guardrails owned here:
//   - AES-256-GCM with a key from env (BOARD_CRED_ENC_KEY, 64 hex chars);
//   - write-only API surface: after a save, no code path returns the secrets —
//     reads outside the publish pipeline get { configured, lastTestedAt } only;
//   - board APIs love echoing credentials back in error bodies, so every error
//     string that could persist or surface goes through maskError() first.

const crypto = require("crypto");
const BoardCredential = require("../models/BoardCredential");

function encryptionKey() {
  const hex = process.env.BOARD_CRED_ENC_KEY || "";
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    const err = new Error(
      "Board credentials are not configured on this platform (BOARD_CRED_ENC_KEY missing)"
    );
    err.status = 503;
    err.code = "BOARD_CREDS_UNCONFIGURED";
    throw err;
  }
  return Buffer.from(hex, "hex");
}

function encrypt(payload) {
  const key = encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
}

function decrypt(row) {
  const key = encryptionKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
  decipher.setAuthTag(Buffer.from(row.authTag, "base64"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(row.ciphertext, "base64")), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

// Upsert a tenant's credentials for one board. `secrets` is a flat JSON object
// (apiKey, username, …) whose shape the board driver defines.
async function saveCredential(companyId, board, secrets) {
  const envelope = encrypt(secrets);
  return BoardCredential.findOneAndUpdate(
    { company: companyId, board: String(board).toLowerCase() },
    { $set: { ...envelope, lastTestedAt: null, lastTestOk: null } },
    { upsert: true, new: true }
  );
}

// Publish-pipeline-only read of the decrypted secrets. Everything else must use
// status() below.
async function loadSecrets(companyId, board) {
  const row = await BoardCredential.findOne({ company: companyId, board: String(board).toLowerCase() });
  if (!row) return null;
  return decrypt(row);
}

// The ONLY shape credentials take outside the publish pipeline.
async function status(companyId, board) {
  const row = await BoardCredential.findOne({ company: companyId, board: String(board).toLowerCase() }).select(
    "board lastTestedAt lastTestOk updatedAt"
  );
  if (!row) return { board, configured: false };
  return { board: row.board, configured: true, lastTestedAt: row.lastTestedAt, lastTestOk: row.lastTestOk, updatedAt: row.updatedAt };
}

async function deleteCredential(companyId, board) {
  const result = await BoardCredential.deleteOne({ company: companyId, board: String(board).toLowerCase() });
  return result?.deletedCount || 0;
}

async function recordTest(companyId, board, ok) {
  await BoardCredential.updateOne(
    { company: companyId, board: String(board).toLowerCase() },
    { $set: { lastTestedAt: new Date(), lastTestOk: !!ok } }
  );
}

// Strip any credential value out of an error string before it is persisted or
// surfaced. Values ≥ 4 chars are replaced; shorter ones aren't distinctive
// enough to leak.
function maskError(message, secrets) {
  let out = String(message || "").slice(0, 2000);
  if (secrets && typeof secrets === "object") {
    for (const value of Object.values(secrets)) {
      const v = String(value ?? "");
      if (v.length >= 4) out = out.split(v).join("***");
    }
  }
  return out;
}

module.exports = { saveCredential, loadSecrets, status, deleteCredential, recordTest, maskError, encrypt, decrypt };
