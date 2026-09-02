// Speech provider abstraction (STT + TTS) for the voice interview.
//
// Deliberately a thin seam so the provider can be swapped without touching callers — the
// current backend responsibility is only to mint a SHORT-LIVED streaming credential; the
// browser streams mic audio straight to the provider (real-time STT) and plays its TTS, so
// raw audio never transits our server. `DEEPGRAM_API_KEY` therefore stays server-side and is
// never shipped to the client.
//
// Provider: Deepgram (for the demo). Post-demo residency swap (self-hosted Whisper / Sarvam AI,
// keeping candidate voice in India for DPDP) replaces `grantStreamingToken` + the client config
// block only — the endpoint/controller contract is unchanged. See [[voice-interview-priority]].
//
// Zero-dependency on purpose (matches utils/logger.js, utils/metrics.js, utils/pdf.js): the
// token grant is a plain HTTPS POST, no SDK on the backend.

const https = require("https");

const GRANT_HOST = "api.deepgram.com";
const GRANT_PATH = "/v1/auth/grant";

function cfg() {
  return {
    apiKey: process.env.DEEPGRAM_API_KEY || "",
    sttModel: process.env.DEEPGRAM_STT_MODEL || "nova-3",
    ttsModel: process.env.DEEPGRAM_TTS_MODEL || "aura-2-thalia-en",
    language: process.env.DEEPGRAM_STT_LANGUAGE || "en",
    // This is now an ASK, not an ANSWER. It used to be the whole end-of-turn decision, which is
    // why it kept being raised (2000 → 3200): every value was wrong, because "are they done?"
    // is not a question about duration. A candidate pausing to find a word was cut off; a
    // candidate who had plainly finished sat in silence for over three seconds.
    //
    // The provider now just tells us early that speech stopped, and utils/endpointing.js decides
    // what that means from the SHAPE of what was said — trailing on "and…" waits generously,
    // a finished sentence with falling energy responds in under a second. So this wants to be
    // near the provider minimum (1000ms), not generous: being told sooner is strictly better
    // once being told no longer ends the turn.
    utteranceEndMs: Number(process.env.DEEPGRAM_UTTERANCE_END_MS || 1000),
    ttlSeconds: Number(process.env.VOICE_TOKEN_TTL_SECONDS || 60),
    // Speaker diarization. Deepgram labels each word with a speaker index on the SAME stream we
    // already open, at no extra cost on nova-3 — so "a second voice answered this question" becomes
    // observable for free. It is by far the strongest integrity signal available to this platform:
    // a camera can be fooled by a phone off-frame, but someone else speaking the answer cannot.
    // Defaults ON; set DEEPGRAM_DIARIZE=false to disable.
    diarize: String(process.env.DEEPGRAM_DIARIZE || "true") !== "false",
  };
}

function isEnabled() {
  return Boolean(cfg().apiKey);
}

function provider() {
  return "deepgram";
}

// POST https://api.deepgram.com/v1/auth/grant  (Authorization: Token <API_KEY>)
// → { access_token, expires_in }. TTL is short (default 60s) — it only has to survive the
// initial WebSocket handshake; the socket then stays open for the whole answer.
function requestGrant(apiKey, ttlSeconds) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ ttl_seconds: ttlSeconds });
    const req = https.request(
      {
        host: GRANT_HOST,
        path: GRANT_PATH,
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 8000,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error(`Deepgram grant failed (${res.statusCode}): ${data.slice(0, 200)}`));
          }
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error("Deepgram grant returned invalid JSON"));
          }
        });
        // Without this, a connection reset mid-response (Deepgram closing the socket early)
        // is an unhandled 'error' on the response stream — Node treats that as fatal.
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Deepgram grant request timed out")));
    req.write(body);
    req.end();
  });
}

// POST https://api.deepgram.com/v1/speak — server-side text-to-speech (Aura). Proxied through
// our backend (not called from the browser) so the API key stays server-side and we dodge
// browser CORS/token-scope pitfalls. Returns raw MP3 bytes.
function requestTts(apiKey, model, text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text });
    const req = https.request(
      {
        host: GRANT_HOST,
        path: `/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3`,
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 15000,
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let e = "";
          res.on("data", (c) => (e += c));
          res.on("end", () => reject(new Error(`Deepgram TTS failed (${res.statusCode}): ${e.slice(0, 200)}`)));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks)));
        // Same as requestGrant: a mid-stream reset must reject the promise, not crash the process.
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Deepgram TTS request timed out")));
    req.write(body);
    req.end();
  });
}

// Stream a spoken question straight through to the candidate's browser.
//
// The difference from `synthesize` below is the whole point: that one waits for Deepgram to
// finish the entire utterance, buffers it on this server, and only then starts sending. A long
// question therefore begins with a second or more of silence, every single time, and none of that
// wait buys anything — the first clause is ready long before the last one is.
//
// This pipes each chunk onward as it arrives, so the browser's <audio> element starts playing on
// the opening words. It ALSO tees the bytes into a buffer, because a repeat has to replay the
// identical audio rather than a fresh synthesis: "could you say that again?" must not be able to
// hand this candidate a subtly different question from the one they were first asked.
//
// `onComplete(buffer)` receives the full audio once the stream ends. Never called on failure.
function streamTts(apiKey, model, text, out, onComplete) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ text });
    const req = https.request(
      {
        host: GRANT_HOST,
        path: `/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3`,
        method: "POST",
        headers: {
          Authorization: `Token ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 20000,
      },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          let e = "";
          res.on("data", (c) => (e += c));
          res.on("end", () => reject(new Error(`Deepgram TTS failed (${res.statusCode}): ${e.slice(0, 200)}`)));
          return;
        }
        const chunks = [];
        res.on("data", (c) => {
          chunks.push(c);
          // Backpressure is the browser's problem to signal and Node's to honour; `write`
          // returning false is handled by the socket buffering, which for a few hundred KB of
          // audio is entirely fine and much simpler than pausing the upstream.
          out.write(c);
        });
        res.on("end", () => {
          const full = Buffer.concat(chunks);
          try {
            onComplete?.(full);
          } catch { /* caching is best-effort — never fail a spoken question over it */ }
          resolve(full);
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Deepgram TTS request timed out")));
    req.write(body);
    req.end();
  });
}

// Roughly how long this text will take to say, for the browser to use before the audio element
// knows its own duration. A streamed response has no Content-Length and `audio.duration` reads
// Infinity until enough has buffered — and the echo gate needs SOME idea of how far through the
// utterance playback is, or it falls back to comparing against the whole sentence and lets fewer
// interruptions through. Deliberately approximate: it is a hint, and the real duration replaces
// it the moment the browser has one.
function estimateSpeechMs(text) {
  const chars = String(text || "").trim().length;
  // ~14ms per character at an ordinary speaking rate, plus a beat of lead-in.
  return Math.round(300 + chars * 14);
}

// Synthesize a spoken question. Returns { audio: Buffer, contentType, model }.
// `voice` optionally overrides the deployment TTS voice with the session's persona voice
// (services/personaService) — an unknown/empty value falls back to the configured default rather
// than failing, so a bad persona voice id can never cost a candidate their interview.
async function synthesize(text, { voice } = {}) {
  const c = cfg();
  if (!c.apiKey) throw Object.assign(new Error("Voice interview is not configured"), { status: 503 });
  const clean = String(text || "").trim().slice(0, 2000);
  if (!clean) throw Object.assign(new Error("text is required"), { status: 400 });
  const model = String(voice || "").trim() || c.ttsModel;
  const audio = await requestTts(c.apiKey, model, clean);
  return { audio, contentType: "audio/mpeg", model };
}

// Same, but written to `out` as it arrives. Returns the full buffer when done.
async function synthesizeTo(out, text, { voice } = {}) {
  const c = cfg();
  if (!c.apiKey) throw Object.assign(new Error("Voice interview is not configured"), { status: 503 });
  const clean = String(text || "").trim().slice(0, 2000);
  if (!clean) throw Object.assign(new Error("text is required"), { status: 400 });
  const model = String(voice || "").trim() || c.ttsModel;
  const audio = await streamTts(c.apiKey, model, clean, out);
  return { audio, contentType: "audio/mpeg", model };
}

// Deepgram spells vocabulary biasing differently per model generation: nova-3 takes repeated
// `keyterm=` params (keyterm prompting), earlier models take `keywords=`. Sending the wrong one
// is silently ignored rather than rejected, so the mapping lives here — the one file that knows
// which provider and model are in play — and the browser is told the param NAME alongside the
// terms. A provider swap then changes this file only.
function keytermParamFor(sttModel) {
  return /^nova-3/i.test(String(sttModel || "")) ? "keyterm" : "keywords";
}

// Whether vocabulary biasing may be sent AT ALL for this model/language pairing.
//
// nova-3's keyterm prompting is ENGLISH-ONLY at Deepgram, and this is the one place where the
// wrong parameter is not silently ignored: sending `keyterm` alongside `language=multi` (or `hi`)
// is REJECTED at connect time, which takes the entire transcript down rather than degrading it.
// The interview then has no evidence at all — strictly worse than the unbiased transcript we get
// by leaving the terms off. Older models' weighted `keywords` carries no such restriction, so
// nova-2 in Hindi keeps its biasing.
//
// The cost of dropping the terms is real and worth naming: an unbiased transcript is where
// "Kubernetes" becomes "cooper netties" and the claim it evidenced looks unsupported. That is a
// degraded measurement, so it is logged where it happens rather than absorbed quietly.
function keytermsSupported(sttModel, language) {
  if (!/^nova-3/i.test(String(sttModel || ""))) return true;
  return /^en(-|$)/i.test(String(language || "en").trim());
}

// Mint a short-lived streaming credential + the client-side STT/TTS config the browser needs.
// `keyterms` is the deterministic technical vocabulary for this candidate/role pairing (see
// utils/keyterms.js); passing none is always valid and just means an unbiased transcript.
async function grantStreamingToken({ keyterms = [] } = {}) {
  const c = cfg();
  if (!c.apiKey) throw Object.assign(new Error("Voice interview is not configured"), { status: 503 });

  const resp = await requestGrant(c.apiKey, c.ttlSeconds);
  const accessToken = resp.access_token || resp.accessToken;
  const expiresIn = resp.expires_in || resp.expiresIn || c.ttlSeconds;
  if (!accessToken) throw new Error("Deepgram grant returned no access_token");

  const terms = Array.isArray(keyterms) ? keyterms : [];
  const biasable = keytermsSupported(c.sttModel, c.language);
  if (terms.length && !biasable) {
    console.warn(
      `[speech] ${c.sttModel} cannot bias vocabulary in "${c.language}" — dropping ${terms.length} ` +
        "keyterm(s) and continuing with an UNBIASED transcript"
    );
  }

  return {
    provider: "deepgram",
    accessToken,
    expiresIn,
    // Streaming STT params (browser passes these to listen.v1.connect). utterance_end_ms +
    // interim_results drive end-of-turn detection so we know when an answer is complete.
    stt: {
      model: c.sttModel,
      language: c.language,
      interimResults: true,
      utteranceEndMs: c.utteranceEndMs,
      punctuate: true,
      smartFormat: true,
      diarize: c.diarize,
      keyterms: biasable ? terms : [],
      keytermParam: keytermParamFor(c.sttModel),
    },
    tts: { model: c.ttsModel },
  };
}

// ---- Cost estimation (Phase 9.4 — voice spend becomes attributable) ----
// Deepgram list prices as overridable defaults: Aura TTS ≈ $0.015 / 1k chars
// (1.5 cents), Nova streaming STT ≈ $0.0077 / min (0.77 cents). Estimates are
// for attribution and budget caps, not invoicing — the provider's bill wins.

function ttsCostCents(chars) {
  const per1k = Number(process.env.DEEPGRAM_TTS_CENTS_PER_1K_CHARS || 1.5);
  return Math.round((Math.max(0, chars) / 1000) * per1k * 100) / 100;
}

function sttCostCents(durationMs) {
  const perMin = Number(process.env.DEEPGRAM_STT_CENTS_PER_MIN || 0.77);
  return Math.round((Math.max(0, durationMs) / 60000) * perMin * 100) / 100;
}

function models() {
  const c = cfg();
  return { sttModel: c.sttModel, ttsModel: c.ttsModel };
}

module.exports = {
  isEnabled,
  provider,
  grantStreamingToken,
  synthesize,
  synthesizeTo,
  streamTts,
  estimateSpeechMs,
  ttsCostCents,
  sttCostCents,
  models,
  keytermParamFor,
  keytermsSupported,
};
