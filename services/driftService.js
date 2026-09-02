// Score-distribution drift detection (BUILD-PLAN Phase 7.5). Per (job, rubric
// version): compare the mean of the most recent assessments against the
// established baseline window. A shift beyond tolerance means a silent model
// change, a prompt regression, or an applicant-pool shift — all of which a
// human should know about. Alerting only; never changes a score.

const AtsAssessment = require("../models/AtsAssessment");
const { notifyAdmin } = require("./notificationService");
const metrics = require("../utils/metrics");

const RECENT_WINDOW = 20;
const BASELINE_MIN = 30; // need this many older scores before drift is meaningful
const MEAN_SHIFT_TOLERANCE = 12; // points

metrics.registerMetric("ats_score_drift", "gauge", "Recent-vs-baseline mean score shift per job+rubricVersion");

/**
 * Fire-and-forget after each persisted assessment. Cheap: two indexed
 * aggregations bounded by the windows.
 */
async function checkDrift({ job, company, rubricVersion }) {
  try {
    const recent = await AtsAssessment.find({ company, job, rubricVersion })
      .sort({ createdAt: -1 })
      .limit(RECENT_WINDOW + BASELINE_MIN)
      .select("overallScore")
      .lean();

    if (recent.length < RECENT_WINDOW + BASELINE_MIN) return null; // not enough history yet

    const recentScores = recent.slice(0, RECENT_WINDOW).map((a) => a.overallScore);
    const baselineScores = recent.slice(RECENT_WINDOW).map((a) => a.overallScore);
    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const shift = mean(recentScores) - mean(baselineScores);

    metrics.setGauge("ats_score_drift", { job: String(job), rubricVersion: String(rubricVersion) }, Math.round(shift * 100) / 100);

    if (Math.abs(shift) > MEAN_SHIFT_TOLERANCE) {
      await notifyAdmin({
        companyId: company,
        type: "system_alert",
        title: "Screening score drift detected",
        message:
          `The last ${RECENT_WINDOW} evidence scores for this job average ${Math.abs(shift).toFixed(1)} points ` +
          `${shift > 0 ? "higher" : "lower"} than the established baseline on the same rubric version. ` +
          `Possible causes: model change, prompt regression, or a shift in the applicant pool. Worth a look.`,
        meta: { jobId: job, rubricVersion, shift: Math.round(shift * 10) / 10 },
      });
      return { drifted: true, shift };
    }
    return { drifted: false, shift };
  } catch (err) {
    console.error("[drift] check failed:", err.message);
    return null;
  }
}

module.exports = { checkDrift, RECENT_WINDOW, BASELINE_MIN, MEAN_SHIFT_TOLERANCE };
