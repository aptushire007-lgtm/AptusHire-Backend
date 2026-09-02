const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { createLimiter } = require("../middleware/rateLimit");
const { careersPage, jobsFeed, jobsSitemap } = require("../controllers/publicCareersController");

// Mounted at the ROOT (not /api): these are crawler-facing URLs.
const router = express.Router();

// Renders are cached ~60s in careersService; this limiter is the second line so
// a hostile crawl loop can't even hit the cache lookup unboundedly.
const crawlLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 120,
  prefix: "rl:careers:",
  message: "Too many requests",
});

router.get("/careers/:companySlug", crawlLimiter, careersPage);
router.get("/feeds/:companySlug/jobs.xml", crawlLimiter, jobsFeed);
router.get("/feeds/:companySlug/sitemap.xml", crawlLimiter, jobsSitemap);

module.exports = wrapRouter(router);
