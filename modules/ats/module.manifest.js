/**
 * ATS Module Manifest (Module 1)
 *
 * Owns: Jobs, Candidates, Pipeline, Review Queue, Analytics, Question Sets,
 * Rubrics, Personas, Intent Phrases, Candidate Dashboard, Data Rights.
 *
 * This manifest declares what the ATS module provides to the module registry.
 * All paths reference the existing flat file structure — files are NOT moved.
 * The registry uses this manifest to conditionally mount routes, start workers,
 * and schedule cron jobs based on the ENABLED_MODULES environment variable.
 */

module.exports = {
  key: "ats",
  displayName: "Applicant Tracking System",

  /**
   * Core capabilities this module depends on.
   * The registry verifies these are available before mounting.
   */
  requiredCore: ["auth", "tenancy", "storage", "queues", "notifications"],

  /**
   * Entitlement flag checked against the License model.
   * A company must have `license.modules.ats.enabled = true` to access these routes.
   */
  entitlementFlag: "ats",

  /**
   * Express routes to mount.
   * Each entry specifies the mount path and the route module to require.
   * The registry calls `app.use(mountPath, routeModule)` for each.
   */
  routes: [
    { path: "/api/jobs", module: "../../routes/jobRoutes" },
    { path: "/api/candidates", module: "../../routes/candidateRoutes" },
    { path: "/api/resumes", module: "../../routes/resumeRoutes" },
    { path: "/api/interview-queue", module: "../../routes/interviewQueueRoutes" },
    { path: "/api/review-queue", module: "../../routes/reviewQueueRoutes" },
    { path: "/api/analytics", module: "../../routes/analyticsRoutes" },
    { path: "/api/jobs/:jobId/question-set", module: "../../routes/questionSetRoutes" },
    { path: "/api/rubrics", module: "../../routes/rubricRoutes" },
    { path: "/api/personas", module: "../../routes/personaRoutes" },
    { path: "/api/intent-phrases", module: "../../routes/intentPhraseRoutes" },
    { path: "/api/candidate-dashboard", module: "../../routes/candidateDashboardRoutes" },
    { path: "/api/data-rights", module: "../../routes/dataRightsRoutes" },
  ],

  /**
   * BullMQ workers to start when this module is enabled.
   * Each entry is { start: requirePath, exportName }.
   */
  workers: [
    { module: "../../workers/screeningWorker", start: "startScreeningWorker" },
    { module: "../../workers/rescoreWorker", start: "startRescoreWorker" },
  ],

  /**
   * Cron jobs to start when this module is enabled.
   * Empty for ATS — its cron needs are covered by core (publishReconcileJob).
   */
  crons: [],
};

