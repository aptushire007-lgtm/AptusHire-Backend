// Generic signed-webhook driver (Tier B) — the "many more boards" escape
// hatch: the tenant points it at their Zapier/n8n/custom endpoint and can relay
// postings to any board we haven't built a first-class driver for yet.
//
// Credential shape: { url, secret }. Every payload is HMAC-SHA256 signed
// (X-AptusHire-Signature) so the receiving automation can verify origin.

const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const http = require("http");
const https = require("https");

function isBlockedAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    if (value.startsWith("::ffff:")) return isBlockedAddress(value.slice(7));
    return value === "::1" || value === "::" || value.startsWith("fc") || value.startsWith("fd") || value.startsWith("fe8") || value.startsWith("fe9") || value.startsWith("fea") || value.startsWith("feb");
  }
  return true;
}

async function validateDestination(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Webhook URL is invalid");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Webhook URL must use HTTP or HTTPS");
  if (parsed.username || parsed.password) throw new Error("Webhook URL must not include credentials");
  if (["localhost", "localhost.localdomain"].includes(parsed.hostname.toLowerCase())) throw new Error("Webhook URL must not target localhost");
  const addresses = await dns.lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) throw new Error("Webhook URL must target a public network address");
  return { parsed, address: addresses[0].address, family: addresses[0].family };
}

function sign(secret, body) {
  return crypto.createHmac("sha256", String(secret)).update(body).digest("hex");
}

async function post(credential, event, payload) {
  const { parsed: destination, address, family } = await validateDestination(credential.url);
  const body = JSON.stringify({ event, sentAt: new Date().toISOString(), ...payload });
  const transport = destination.protocol === "https:" ? https : http;
  const res = await new Promise((resolve, reject) => {
    const request = transport.request({
      protocol: destination.protocol,
      hostname: destination.hostname,
      port: destination.port || undefined,
      path: `${destination.pathname}${destination.search}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-AptusHire-Signature": sign(credential.secret, body),
      },
      lookup: (_hostname, _options, callback) => callback(null, address, family),
      timeout: 10000,
    }, (response) => {
      response.resume();
      response.on("end", () => resolve(response));
    });
    request.on("timeout", () => request.destroy(new Error("Webhook request timed out")));
    request.on("error", reject);
    request.end(body);
  });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`Webhook responded ${res.statusCode}`);
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
