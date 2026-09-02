// Tier C partner drivers (Phase 15.6) — LinkedIn / Indeed sponsored /
// ZipRecruiter. These require an approved platform partnership (historically
// months of external process), so the drivers are built and tested against
// recorded fixtures behind the SAME interface as every other board and ship
// DISABLED: the UI shows "awaiting partner approval", and the day approval
// lands, enabling one is a config change (the env flag), not a project.
//
// The partner-program APPLICATIONS are an owner action tracked in BUILD-PLAN —
// nothing in this codebase can substitute for filing them.

function makePartnerDriver({ key, name, envFlag, apiBaseEnv, defaultBase }) {
  const BASE = () => (process.env[apiBaseEnv] || defaultBase).replace(/\/$/, "");

  async function defaultHttp({ method, path, credential, body }) {
    const res = await fetch(`${BASE()}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential.accessToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(json.message || `${name} API responded ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }

  const driver = {
    key,
    name,
    tier: "C",
    needsCredential: true,
    _http: defaultHttp,

    available() {
      if (process.env[envFlag] === "true") return { enabled: true };
      return { enabled: false, reason: "awaiting partner approval" };
    },

    validate(job) {
      const errors = [];
      if (!job.title) errors.push("A job title is required");
      if (!job.description) errors.push("A description is required");
      if (!job.location) errors.push(`${name} requires a location`);
      return errors;
    },

    async publish({ job, credential, existing }) {
      if (!driver.available().enabled) throw new Error(`${name} integration is awaiting partner approval`);
      const body = { title: job.title, description: job.description, location: job.location };
      if (existing) {
        const out = await driver._http({ method: "PUT", path: `/v1/postings/${existing}`, credential, body });
        return { externalRef: existing, externalUrl: out.url };
      }
      const out = await driver._http({ method: "POST", path: "/v1/postings", credential, body });
      return { externalRef: String(out.id), externalUrl: out.url };
    },

    async update(ctx) {
      return driver.publish({ ...ctx, existing: ctx.externalRef });
    },

    async withdraw({ credential, externalRef }) {
      if (!driver.available().enabled || !externalRef) return {};
      await driver._http({ method: "DELETE", path: `/v1/postings/${externalRef}`, credential });
      return {};
    },

    async checkStatus({ credential, externalRef }) {
      const out = await driver._http({ method: "GET", path: `/v1/postings/${externalRef}`, credential });
      const map = { ACTIVE: "published", EXPIRED: "expired", CLOSED: "withdrawn" };
      return { status: map[out.status] || "published", externalUrl: out.url };
    },
  };

  return driver;
}

module.exports = { makePartnerDriver };
