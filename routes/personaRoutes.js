const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { listPersonas, createPersona, updatePersona, approvePersona } = require("../controllers/personaController");
const { requireAuth, requireRole, requireActiveCompany } = require("../middleware/auth");

const router = express.Router();
const requireAdmin = [requireAuth, requireRole("admin"), requireActiveCompany];

router.get("/", requireAdmin, listPersonas);
router.post("/", requireAdmin, createPersona);
router.patch("/:id", requireAdmin, updatePersona);
router.post("/:id/approve", requireAdmin, approvePersona);

module.exports = wrapRouter(router);
