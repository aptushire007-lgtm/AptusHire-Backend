/**
 * Interview Module Manifest (Module 3)
 *
 * Owns: Interview sessions, AI scoring & reports, LiveKit realtime pipeline,
 * voice agent dispatch, assessment engine, scorecard engine, proctoring.
 *
 * This is the most self-contained module — it can be offered standalone to
 * enterprises that have their own ATS but want AI-powered interviews.
 * See Modular-Enterprise-Integration-Plan.md "Worked example" for the
 * external integration flow.
 */

module.exports = {
  key: "interview",
  displayName: "AI Interview Platform",

  requiredCore: ["auth", "tenancy", "llm", "storage", "queues", "notifications"],

  entitlementFlag: "interview",

  routes: [
    { path: "/api/interview-sessions", module: "../../routes/interviewSessionRoutes" },
    { path: "/api/interview-portal", module: "../../routes/interviewPortalRoutes" },
    // Realtime engine endpoints (function dispatch + transcript/guardrail).
    // Called by the LiveKit agent worker on the candidate's portal JWT.
    // The path predates the LiveKit pipeline — do not rename.
    { path: "/api/interview-portal/realtime", module: "../../routes/voiceAgentRoutes" },
    // LiveKit realtime pipeline: availability probe, session mint, worker brief, metering close.
    { path: "/api/interview-portal/livekit", module: "../../routes/livekitRoutes" },
  ],

  /**
   * Conditionally mounted routes — these have their own feature flags
   * and are only mounted when BOTH the module is enabled AND the feature
   * flag is on. The registry handles the gating logic.
   */
  conditionalRoutes: [
    {
      // Assessment engine (proctored technical papers)
      condition: () => require("../../services/assessmentPaperService").engineEnabled(),
      routes: [
        { path: "/api/assessments", module: "../../routes/assessmentRoutes" },
        { path: "/api/assessment-portal", module: "../../routes/assessmentPortalRoutes" },
      ],
    },
    {
      // Human-round scorecards
      condition: () => process.env.SCORECARD_ENGINE_ENABLED === "true",
      routes: [
        { path: "/api/scorecards", module: "../../routes/scorecardRoutes" },
        { path: "/api/scorecard-portal", module: "../../routes/scorecardPortalRoutes" },
      ],
    },
  ],

  /**
   * Raw-body webhook routes — these must be mounted BEFORE express.json()
   * because they need the exact request bytes for signature verification.
   * The registry handles this ordering constraint.
   */
  rawWebhooks: [
    {
      path: "/api/webhooks/livekit",
      handler: "../../controllers/livekitController",
      exportName: "livekitWebhook",
    },
  ],

  workers: [
    { module: "../../workers/finalizationWorker", start: "startFinalizationWorker" },
  ],

  crons: [
    { module: "../../jobs/interviewReminderJob", start: "startInterviewReminderJob" },
    {
      module: "../../jobs/assessmentReminderJob",
      start: "startAssessmentReminderJob",
      condition: () => require("../../services/assessmentPaperService").engineEnabled(),
    },
    { module: "../../jobs/calibrationJob", start: "startCalibrationJob" },
  ],
};

