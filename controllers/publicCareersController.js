// Public, unauthenticated distribution surface (Phase 15.2 / 15.3): the
// careers page, the aggregator XML feed, and the jobs sitemap. Everything here
// is cached (~60s) and rate-limited at the router so a naive crawler loop
// never turns into Mongo load, and renders ONLY published jobs of ACTIVE
// companies (careersService owns those guarantees).

const CompanySettings = require("../models/CompanySettings");
const careersService = require("../services/careersService");

async function resolveOrRedirect(req, res, kind) {
  const resolved = await careersService.resolveCompanyBySlug(req.params.companySlug);
  if (!resolved) {
    res.status(404).type("text/plain").send("Not found");
    return null;
  }
  const settings = await CompanySettings.findOne({ company: resolved.company._id }).select("careers branding");
  if (!careersService.careersEnabled(settings)) {
    res.status(404).type("text/plain").send("Not found");
    return null;
  }
  // A renamed slug keeps working: 301 to the canonical URL so published links
  // never die and crawlers consolidate on one address.
  if (!resolved.canonical) {
    const paths = {
      careers: `/careers/${resolved.company.slug}`,
      feed: `/feeds/${resolved.company.slug}/jobs.xml`,
      sitemap: `/feeds/${resolved.company.slug}/sitemap.xml`,
    };
    res.redirect(301, paths[kind]);
    return null;
  }
  return resolved.company;
}

async function careersPage(req, res) {
  const company = await resolveOrRedirect(req, res, "careers");
  if (!company) return;
  const { body, contentType } = await careersService.renderCareersPage(company);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=60");
  res.send(body);
}

async function jobsFeed(req, res) {
  const company = await resolveOrRedirect(req, res, "feed");
  if (!company) return;
  const { body, contentType } = await careersService.renderJobsFeed(company);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=60");
  res.send(body);
}

async function jobsSitemap(req, res) {
  const company = await resolveOrRedirect(req, res, "sitemap");
  if (!company) return;
  const { body, contentType } = await careersService.renderJobsSitemap(company);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=60");
  res.send(body);
}

module.exports = { careersPage, jobsFeed, jobsSitemap };
