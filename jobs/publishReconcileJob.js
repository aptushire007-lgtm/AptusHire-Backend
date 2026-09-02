// Nightly publish reconcile (BUILD-PLAN Phase 15.8) — re-checks every live
// listing against its board so the UI never shows "published" for a listing
// the board dropped, expires listings past validThrough, and withdraws rows
// whose local job is no longer published. Never auto-republishes anything.

const { schedule, cronTimezone } = require("../utils/cronSchedule");
const tenantContext = require("../utils/tenantContext");
const { reconcileAll } = require("../services/jobPublishService");

function startPublishReconcileJob() {
  if (process.env.PUBLISH_RECONCILE_ENABLED === "false") {
    console.log("[publishReconcile] disabled (PUBLISH_RECONCILE_ENABLED=false)");
    return;
  }
  // 03:45 daily — after the retention job, before business hours.
  schedule("45 3 * * *", () => {
    tenantContext
      .runAsSystem(() => reconcileAll())
      .then(({ checked, synced }) => {
        if (checked) console.log(`[publishReconcile] checked ${checked} listing(s), synced ${synced}`);
      })
      .catch((err) => console.error("[publishReconcile] run failed:", err.message));
  });
  console.log(`[publishReconcile] scheduled daily at 03:45 ${cronTimezone()}`);
}

module.exports = { startPublishReconcileJob };
