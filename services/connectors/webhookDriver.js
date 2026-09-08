// Generic signed-webhook driver (Tier B) — the "many more boards" escape
// hatch: the tenant points it at their Zapier/n8n/custom endpoint and can relay
// postings to any board we haven't built a first-class driver for yet.
//
// Credential shape: { url, secret }. Every payload is HMAC-SHA256 signed
// (X-AptusHire-Signature) so the receiving automation can verify origin.

const crypto = require("crypto");

function sign(secret, body) {
  return crypto.createHmac("sha256", String(secret)).update(body).digest("hex");
}

async function post(credential, event, payload) {
  const body = JSON.stringify({ event, sentAt: new Date().toISOString(), ...payload });
  const res = await fetch(credential.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AptusHire-Signature": sign(credential.secret, body),
    },
    body,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    throw new Error(`Webhook responded ${res.status}`);
  }
  return res;
}

function jobPayload(job) {
  return {
    job: {
      id: String(job._id),
      title: job.title,
      department: job.department,
      location: job.location,
      description: job.description,
      requirements: job.requirements,
      slug: job.slug,
      numberOfOpenings: job.numberOfOpenings,
      filledOpenings: job.filledOpenings,
      pendingOffers: job.pendingOffers,
      status: job.status,
    },
  };
}

module.exports = {
  key: "webhook",
  name: "Webhook (Zapier / n8n / custom)",
  tier: "B",
  needsCredential: true,

  available() {
    return { enabled: true };
  },

  validate(job) {
    const errors = [];
    if (!job.title) errors.push("A job title is required");
    if (!job.description) errors.push("A description is required");
    return errors;
  },

  async publish({ job, credential, existing }) {
    if (!credential?.url || !credential?.secret) throw new Error("Webhook URL and secret are not configured");
    await post(credential, existing ? "job.updated" : "job.published", jobPayload(job));
    return { externalRef: existing || String(job._id), externalUrl: credential.url };
  },

  async update(ctx) {
    return this.publish({ ...ctx, existing: ctx.externalRef });
  },

  async withdraw({ job, credential, externalRef }) {
    if (!credential?.url || !credential?.secret) return {};
    await post(credential, "job.withdrawn", {
      job: {
        id: externalRef || String(job?._id),
        status: job?.status,
        closureReason: job?.closureReason,
        numberOfOpenings: job?.numberOfOpenings,
        filledOpenings: job?.filledOpenings,
      },
    });
    return {};
  },

  async checkStatus() {
    return { status: "published" }; // webhooks are fire-and-forget; the receiver owns downstream state
  },

  async testConnection(credential) {
    await post(credential, "connection.test", { ok: true });
    return true;
  },
};
