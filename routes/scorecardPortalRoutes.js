// Panelist scorecard portal routes. Magic-link login → JWT with aud "scorecard";
// requireScorecardAuth re-checks status + expiry on every authed call and scopes
// the request to the scorecard's tenant.

const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { login, me, submit } = require("../controllers/scorecardPortalController");
const { requireScorecardAuth } = require("../middleware/scorecardAuth");
const { createLimiter, portalKey } = require("../middleware/rateLimit");
const asyncHandler = require("../middleware/asyncHandler");

const router = express.Router();

const loginLimiter = createLimiter({ windowMs: 60 * 1000, max: 20, prefix: "rl:scorecard-login:" });
// Submission is once-per-scorecard by design; the limiter only exists to blunt
// a retry storm from a flaky mobile connection.
const submitLimiter = createLimiter({ windowMs: 60 * 1000, max: 10, prefix: "rl:scorecard-submit:", keyGenerator: portalKey });

router.post("/login", loginLimiter, asyncHandler(login));
router.get("/me", requireScorecardAuth, asyncHandler(me));
router.post("/submit", requireScorecardAuth, submitLimiter, asyncHandler(submit));

module.exports = wrapRouter(router);
