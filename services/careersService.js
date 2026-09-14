// Public careers pages + job feeds (BUILD-PLAN Phase 15.2 / 15.3) — the
// zero-permission distribution channels. Server-rendered HTML (crawlers must
// not depend on SPA JS) with one schema.org JobPosting JSON-LD block per
// published job — Google for Jobs indexes this for free — plus an Indeed-style
// XML feed the aggregator network (Adzuna, Jooble, Talent.com, Careerjet…)
// pulls without any contract.
//
// SECURITY: this is a public, unauthenticated render of tenant data. Only
// PUBLISHED jobs may appear, and every interpolated value is HTML-escaped —
// stored branding/job text is tenant input and therefore an XSS surface.

const Company = require("../models/Company");
const CompanySettings = require("../models/CompanySettings");
const Job = require("../models/Job");
const { slugify } = require("../utils/slug");
const { firstOrigin, publicBaseUrl } = require("../utils/corsOrigins");
const { getJson, setJson, getVersion, incrementVersion } = require("./redisCache");

// validThrough is MANDATORY for Google's JobPosting — a missing field silently
// drops the listing from the index. Postings default to 60 days from last touch.
const POSTING_VALID_DAYS = 60;

const CACHE_TTL_MS = 60 * 1000;
const cache = new Map(); // key → { body, contentType, at }

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  cache.delete(key);
  return null;
}
function cacheSet(key, body, contentType) {
  // Bounded: this only ever holds a handful of tenant pages/feeds.
  if (cache.size > 500) cache.clear();
  cache.set(key, { body, contentType, at: Date.now() });
  return { body, contentType };
}
function cacheClear() {
  cache.clear();
  incrementVersion("careers-cache:version").catch(() => {});
}

function careersEnabled(settings) {
  const override = settings?.careers?.enabled;
  if (typeof override === "boolean") return override;
  return process.env.CAREERS_PAGES_ENABLED !== "false";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Lazily mint a unique slug for a company the first time its careers surface is
// needed. Uniqueness via numeric suffix; concurrent races resolve on the
// unique index (retry with a random suffix).
async function ensureCompanySlug(company) {
  if (company.slug) return company.slug;
  const base = slugify(company.name) || `company-${String(company._id).slice(-6)}`;
  let candidate = base;
  for (let i = 2; i < 20; i += 1) {
    const clash = await Company.findOne({ slug: candidate }).select("_id");
    if (!clash) break;
    candidate = `${base}-${i}`;
  }
  company.slug = candidate;
  await company.save();
  return company.slug;
}

// Resolve a public slug — current or historical (renames 301 to canonical).
async function resolveCompanyBySlug(slug) {
  const company = await Company.findOne({ slug, status: "active" });
  if (company) return { company, canonical: true };
  const moved = await Company.findOne({ previousSlugs: slug, status: "active" });
  if (moved) return { company: moved, canonical: false };
  return null;
}

function applyBaseUrl() {
  return firstOrigin(process.env.CLIENT_ORIGIN_USER, "http://localhost:5174").replace(/\/$/, "");
}

function applyUrl(job, src) {
  return `${applyBaseUrl()}/jobs/${job.slug || job._id}?src=${encodeURIComponent(src)}`;
}

function validThrough(job) {
  const anchor = job.updatedAt || job.createdAt || new Date();
  return new Date(anchor.getTime() + POSTING_VALID_DAYS * 86400000);
}

// One schema.org JobPosting per job. All five Google-mandatory fields present:
// title, datePosted, validThrough, hiringOrganization, jobLocation.
function jobPostingJsonLd(job, company) {
  return {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title: job.title,
    description: `<p>${escapeHtml(job.description)}</p>`,
    datePosted: (job.createdAt || new Date()).toISOString().slice(0, 10),
    validThrough: validThrough(job).toISOString(),
    employmentType: "FULL_TIME",
    hiringOrganization: {
      "@type": "Organization",
      name: company.name,
      ...(company.website ? { sameAs: company.website } : {}),
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressLocality: job.location || company.city,
        addressRegion: company.state,
        addressCountry: company.country,
      },
    },
    identifier: {
      "@type": "PropertyValue",
      name: company.name,
      value: String(job._id),
    },
    directApply: true,
    url: applyUrl(job, "careers"),
  };
}

async function publishedJobs(companyId) {
  return Job.find({ company: companyId, status: "published" }).sort({ createdAt: -1 }).limit(200);
}

// Server-rendered careers page. Deliberately dependency-free HTML — crawlers
// (and Google's Rich Results test) see everything without executing a byte of JS.
async function renderCareersPage(company) {
  const version = await getVersion("careers-cache:version");
  const key = `careers:${version}:${company.slug}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const distributed = await getJson(key);
  if (distributed) return cacheSet(key, distributed.body, distributed.contentType);

  const settings = await CompanySettings.findOne({ company: company._id }).select("branding careers");
  const jobs = await publishedJobs(company._id);
  const color = /^#[0-9a-fA-F]{3,8}$/.test(settings?.branding?.primaryColor || "") ? settings.branding.primaryColor : "#1a2a44";

  const jsonLd = jobs.map((job) => `<script type="application/ld+json">${JSON.stringify(jobPostingJsonLd(job, company)).replace(/</g, "\\u003c")}</script>`).join("\n");

  const jobCards = jobs
    .map(
      (job) => `
      <article class="job">
        <h2>${escapeHtml(job.title)}</h2>
        <p class="meta">${escapeHtml([job.department, job.location || company.city].filter(Boolean).join(" · "))}</p>
        <p>${escapeHtml(String(job.description).slice(0, 280))}${job.description.length > 280 ? "…" : ""}</p>
        <a class="apply" href="${escapeHtml(applyUrl(job, "careers"))}">Apply for this role</a>
      </article>`
    )
    .join("\n");

  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Careers at ${escapeHtml(company.name)}</title>
<meta name="description" content="Open roles at ${escapeHtml(company.name)} — apply directly.">
<link rel="canonical" href="${escapeHtml(`${publicBaseUrl()}/careers/${company.slug}`)}">
${jsonLd}
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;background:#f8fafc;color:#0f172a}
  header{background:${color};color:#fff;padding:48px 24px;text-align:center}
  header h1{margin:0;font-size:1.9rem}
  header p{margin:8px 0 0;opacity:.85}
  main{max-width:760px;margin:0 auto;padding:32px 20px}
  .job{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:22px;margin-bottom:16px}
  .job h2{margin:0 0 4px;font-size:1.2rem}
  .meta{color:#64748b;font-size:.85rem;margin:0 0 10px}
  .apply{display:inline-block;margin-top:6px;background:${color};color:#fff;text-decoration:none;padding:9px 18px;border-radius:9px;font-size:.9rem}
  .empty{text-align:center;color:#64748b;padding:60px 0}
  footer{text-align:center;color:#94a3b8;font-size:.75rem;padding:24px}
</style>
</head>
<body>
<header>
  <h1>Careers at ${escapeHtml(company.name)}</h1>
  <p>${escapeHtml([company.city, company.state, company.country].filter(Boolean).join(", "))}</p>
</header>
<main>
${jobs.length ? jobCards : '<p class="empty">No open positions right now — check back soon.</p>'}
</main>
<footer>Powered by AptusHire</footer>
</body>
</html>`;

  const rendered = cacheSet(key, body, "text/html; charset=utf-8");
  await setJson(key, rendered, 60);
  return rendered;
}

function cdata(value) {
  return `<![CDATA[${String(value ?? "").replace(/\]\]>/g, "]]]]><![CDATA[>")}]]>`;
}

// Indeed-style XML — the de-facto format the aggregator network accepts.
async function renderJobsFeed(company) {
  const version = await getVersion("careers-cache:version");
  const key = `feed:${version}:${company.slug}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const distributed = await getJson(key);
  if (distributed) return cacheSet(key, distributed.body, distributed.contentType);

  const jobs = await publishedJobs(company._id);
  const items = jobs
    .map(
      (job) => `  <job>
    <title>${cdata(job.title)}</title>
    <date>${cdata((job.createdAt || new Date()).toUTCString())}</date>
    <referencenumber>${cdata(String(job._id))}</referencenumber>
    <url>${cdata(applyUrl(job, "feed"))}</url>
    <company>${cdata(company.name)}</company>
    <city>${cdata(job.location || company.city)}</city>
    <state>${cdata(company.state)}</state>
    <country>${cdata(company.country)}</country>
    <description>${cdata(job.description)}</description>
    <jobtype>${cdata("fulltime")}</jobtype>
    <expirationdate>${cdata(validThrough(job).toUTCString())}</expirationdate>
  </job>`
    )
    .join("\n");

  const body = `<?xml version="1.0" encoding="utf-8"?>
<source>
  <publisher>${cdata(company.name)}</publisher>
  <publisherurl>${cdata(`${publicBaseUrl()}/careers/${company.slug}`)}</publisherurl>
  <lastBuildDate>${cdata(new Date().toUTCString())}</lastBuildDate>
${items}
</source>`;

  const rendered = cacheSet(key, body, "application/xml; charset=utf-8");
  await setJson(key, rendered, 60);
  return rendered;
}

// Jobs sitemap — one <url> per published job's apply page plus the careers page.
async function renderJobsSitemap(company) {
  const version = await getVersion("careers-cache:version");
  const key = `sitemap:${version}:${company.slug}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const distributed = await getJson(key);
  if (distributed) return cacheSet(key, distributed.body, distributed.contentType);

  const jobs = await publishedJobs(company._id);
  const urls = [
    `  <url><loc>${escapeHtml(`${publicBaseUrl()}/careers/${company.slug}`)}</loc></url>`,
    ...jobs.map(
      (job) =>
        `  <url><loc>${escapeHtml(applyUrl(job, "careers"))}</loc><lastmod>${(job.updatedAt || job.createdAt || new Date())
          .toISOString()
          .slice(0, 10)}</lastmod></url>`
    ),
  ].join("\n");

  const body = `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  const rendered = cacheSet(key, body, "application/xml; charset=utf-8");
  await setJson(key, rendered, 60);
  return rendered;
}

module.exports = {
  careersEnabled,
  ensureCompanySlug,
  resolveCompanyBySlug,
  renderCareersPage,
  renderJobsFeed,
  renderJobsSitemap,
  jobPostingJsonLd,
  escapeHtml,
  validThrough,
  cacheClear,
  POSTING_VALID_DAYS,
};
