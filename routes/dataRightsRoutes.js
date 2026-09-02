const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { exportCandidateData, eraseCandidateData, getDpoContact } = require("../controllers/dataRightsController");
const { requireAuth, requireRole, requireActiveCompany } = require("../middleware/auth");

const router = express.Router();
const requireAdmin = [requireAuth, requireRole("admin"), requireActiveCompany];

// DPDP data-principal rights — the tenant (data fiduciary) acts on behalf of candidates.
router.get("/candidates/:id/export", requireAdmin, exportCandidateData);
router.delete("/candidates/:id", requireAdmin, eraseCandidateData);

// Public grievance / Data-Protection Officer contact for a company.
router.get("/dpo/:companyId", getDpoContact);

module.exports = wrapRouter(router);
