// Nightly calibration recompute (BUILD-PLAN Phase 10.2). For every tenant with
// decided outcomes, rebuild the score→advancement curve. Display-only output —
// see services/calibrationService.js for the hard rules.

const { schedule, cronTimezone } = require("../utils/cronSchedule");
const ScoreOutcome = require("../models/ScoreOutcome");
const calibrationService = require("../services/calibrationService");
const tenantContext = require("../utils/tenantContext");

async function recomputeAll() {
  const companies = await ScoreOutcome.distinct("company", { outcome: { $in: ["advanced", "rejected"] } });
  for (const companyId of companies) {
    try {
      await calibrationService.computeForCompany(companyId);
    } catch (err) {
      console.error(`[calibrationJob] recompute failed for company ${companyId}:`, err.message);
    }
  }
  if (companies.length) console.log(`[calibrationJob] recomputed calibration for ${companies.length} tenant(s)`);
}

function startCalibrationJob() {
  schedule("30 2 * * *", () => {
    tenantContext
      .runAsSystem(() => recomputeAll())
      .catch((err) => console.error("[calibrationJob] run failed:", err.message));
  });
  console.log(`[calibrationJob] scheduled daily at 02:30 ${cronTimezone()}`);
}

module.exports = { startCalibrationJob, recomputeAll };
