const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { listIntentPhrases, decideIntentPhrase } = require("../controllers/intentPhraseController");
const { requireAuth, requireRole, requireActiveCompany } = require("../middleware/auth");

const router = express.Router();
const requireAdmin = [requireAuth, requireRole("admin"), requireActiveCompany];

// Phrasings the interviewer's rules missed and the model had to read, so a recruiter can promote
// the recurring ones into instant rules. See models/IntentPhrase.js.
router.get("/", requireAdmin, listIntentPhrases);
router.patch("/:id", requireAdmin, decideIntentPhrase);

module.exports = wrapRouter(router);
