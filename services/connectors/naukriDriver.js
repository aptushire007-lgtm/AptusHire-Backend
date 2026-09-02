// Naukri RMS driver (Tier B — BYO subscription). The tenant already pays for
// Naukri recruiter seats; they request client-API credentials from their
// account manager and connect them in Settings → Integrations. We are their
// client tooling — no Info Edge platform partnership required.
//
// The HTTP transport is injectable (`_http`) so the driver is developed and
// tested against RECORDED API fixtures (test/fixtures/naukri/*.json) — the
// same interface real credentials will use, so going live is configuration,
// not a rewrite. Credential shape: { clientId, apiKey }.

const BASE = () => (process.env.NAUKRI_API_BASE || "https://rms-api.naukri.example").replace(/\/$/, "");

async function defaultHttp({ method, path, credential, body }) {
  const res = await fetch(`${BASE()}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Client-Id": credential.clientId,
      Authorization: `Bearer ${credential.apiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.message || `Naukri API responded ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

function jobBody(job) {
  return {
    title: job.title,
    description: job.description,
    functionalArea: job.department,
    location: job.location,
    // Naukri's own listing lifetime; our reconcile keeps the local row honest.
    validityDays: 30,
  };
}

const driver = {
  key: "naukri",
  name: "Naukri (RMS)",
  tier: "B",
  needsCredential: true,
  _http: defaultHttp, // injectable transport (fixtures in tests)

  available() {
    return { enabled: true };
  },

  // Board-specific requirements surfaced in the publish UI before any API call.
  validate(job) {
    const errors = [];
    if (!job.title) errors.push("A job title is required");
    if (!job.department) errors.push("Naukri requires a functional area — set the job's department");
    if (!job.location) errors.push("Naukri requires a location");
    if (!job.description || job.description.length < 50) errors.push("Naukri requires a description of at least 50 characters");
    return errors;
  },

  async publish({ job, credential, existing }) {
    if (!credential?.clientId || !credential?.apiKey) throw new Error("Naukri credentials are not configured");
    if (existing) {
      // Idempotent re-publish: update the existing listing, never a duplicate.
      const out = await driver._http({ method: "PUT", path: `/v1/jobs/${existing}`, credential, body: jobBody(job) });
      return { externalRef: existing, externalUrl: out.listingUrl };
    }
    const out = await driver._http({ method: "POST", path: "/v1/jobs", credential, body: jobBody(job) });
    return { externalRef: String(out.jobId), externalUrl: out.listingUrl };
  },

  async update(ctx) {
    return driver.publish({ ...ctx, existing: ctx.externalRef });
  },

  async withdraw({ credential, externalRef }) {
    if (!externalRef) return {};
    await driver._http({ method: "DELETE", path: `/v1/jobs/${externalRef}`, credential });
    return {};
  },

  async checkStatus({ credential, externalRef }) {
    const out = await driver._http({ method: "GET", path: `/v1/jobs/${externalRef}`, credential });
    const map = { LIVE: "published", EXPIRED: "expired", REMOVED: "withdrawn" };
    return { status: map[out.status] || "published", externalUrl: out.listingUrl };
  },

  async testConnection(credential) {
    await driver._http({ method: "GET", path: "/v1/account", credential });
    return true;
  },
};

module.exports = driver;
