// CLIENT_ORIGIN_ADMIN / CLIENT_ORIGIN_USER may each hold a comma-separated list of
// origins (e.g. "http://192.168.1.23:5174,http://localhost:5174") so the same Vite
// dev server can be reached both from the host machine (localhost) and from a phone
// or other device on the LAN, without disabling CORS or juggling two different .env
// files for the same running server.

// A browser's Origin header is scheme+host+port with NO trailing slash, and the cors
// package compares this list by exact string equality — so one pasted "https://x/"
// silently rejects every request and every socket handshake from that app. The paste
// comes from a browser address bar or a Render/Vercel dashboard, both of which show
// the slash, and the failure looks nothing like its cause: link-building uses
// normalizeBase(), which already strips it, so the interview EMAILS keep working
// while the SPA cannot reach the API at all. Strip it here too.
function parseOrigins(...envValues) {
  return envValues
    .filter(Boolean)
    .flatMap((v) => v.split(","))
    .map((v) => v.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

// Link-builders (magic-link emails, QR pairing URLs, password-reset links) need
// exactly ONE base URL, not a CORS allow-list — take the first configured origin
// (the one meant to be shared/scanned), falling back to `fallback` when unset.
function firstOrigin(envValue, fallback) {
  const [first] = parseOrigins(envValue);
  return first || fallback;
}

// Hostnames handed out by dev-tunnel services. Every one of them is disposable:
// the name is re-randomised on each run (trycloudflare) or tied to a session that
// ends when the laptop sleeps. An interview link is valid for INTERVIEW_LINK_VALIDITY_HOURS
// (48h by default) and the invitation email tells the candidate to "take it whenever
// suits you" — a hostname that dies in hours cannot honour a promise measured in days.
// Only the token HASH is persisted, so a link built on one of these is unrecoverable
// once the host is gone (the raw token still is, but only if the candidate still has
// the email to copy it out of).
const DISPOSABLE_HOST_PATTERNS = [
  /(^|\.)trycloudflare\.com$/i,
  /(^|\.)ngrok(-free)?\.(app|io|dev)$/i,
  /(^|\.)devtunnels\.ms$/i,
  /(^|\.)loca\.lt$/i,
  /(^|\.)serveo\.net$/i,
  /(^|\.)tunnelmole\.net$/i,
];

// A bare host ("app.onrender.com") is a very easy thing to paste into
// PUBLIC_CANDIDATE_URL — Render/Vercel/Netlify all display the hostname without a
// scheme. Without this, buildInterviewUrl emits "app.onrender.com/interview/<token>",
// which mail clients render as a relative path and no browser will open.
function normalizeBase(url) {
  const trimmed = String(url || "").trim().replace(/\/+$/, "");
  if (!trimmed) return trimmed;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function hostOf(url) {
  try {
    return new URL(normalizeBase(url)).hostname;
  } catch {
    return "";
  }
}

// Exported so boot-time validation can refuse to start a production deploy that
// would email links nobody can open. See config/env.js.
function isDisposableHost(url) {
  const host = hostOf(url);
  return Boolean(host) && DISPOSABLE_HOST_PATTERNS.some((re) => re.test(host));
}

function isLocalHost(url) {
  const host = hostOf(url);
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || /^192\.168\./.test(host) || /^10\./.test(host);
}

// The base for CANDIDATE-facing links that go into emails (interview magic
// links, QR pairing). PUBLIC_CANDIDATE_URL, when set, wins over the CORS list —
// emailed links must never depend on the ORDER of CLIENT_ORIGIN_USER, where a
// dev tunnel (trycloudflare etc.) listed first silently bakes a disposable
// hostname into every invitation, and every link dies when the tunnel does.
function candidateLinkBase(fallback = "http://localhost:5174") {
  return normalizeBase(firstOrigin(process.env.PUBLIC_CANDIDATE_URL || process.env.CLIENT_ORIGIN_USER, fallback));
}

// The base for links that point back at THIS backend: careers pages, aggregator
// feeds, sitemaps, JSON-LD canonicals, and the backendUrl handed to the LiveKit
// worker in dispatch metadata. Same bare-host paste hazard as candidateLinkBase
// (Railway/Render/Vercel all display a hostname with no scheme), but it fails
// later and further away: a schemeless canonical is read by crawlers as a
// RELATIVE path, and httpx in the Python worker refuses the request outright
// ("Request URL is missing an 'http://' or 'https://' protocol") — which surfaces
// as an interview that dies in a different service, in a different language,
// with no mention of the variable that caused it.
function publicBaseUrl(fallback = `http://localhost:${process.env.PORT || 9000}`) {
  return normalizeBase(process.env.PUBLIC_BASE_URL || fallback);
}

module.exports = {
  parseOrigins,
  firstOrigin,
  candidateLinkBase,
  publicBaseUrl,
  isDisposableHost,
  isLocalHost,
  normalizeBase,
};
