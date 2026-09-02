const express = require("express");
const wrapRouter = require("../middleware/wrapRouter");
const { getMine, updateMine } = require("../controllers/notificationPreferenceController");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/me", requireAuth, getMine);
router.patch("/me", requireAuth, updateMine);

module.exports = wrapRouter(router);
