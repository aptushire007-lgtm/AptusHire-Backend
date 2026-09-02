/**
 * Resume Module Manifest (Module 2)
 *
 * Owns: Resume ingestion, PDF/DOCX parsing, claim graph analysis,
 * template normalization.
 *
 * NOTE: In the current codebase, resume routes are mounted at /api/resumes
 * and are also referenced by the ATS module (candidate applications include
 * resume upload). The ATS manifest mounts resumeRoutes because the candidate
 * application flow requires it. This module exists as a separate boundary
 * for when resume processing is offered as a standalone product
 * (e.g., a job board embedding just the resume parser).
 *
 * When ENABLED_MODULES=resume (standalone), only resume-specific routes mount.
 * When ENABLED_MODULES=ats,resume (bundled), both mount — the ATS module's
 * resumeRoutes reference and this module's routes are the same Express router,
 * so Express deduplicates naturally.
 */

module.exports = {
  key: "resume",
  displayName: "Resume Intelligence",

  requiredCore: ["auth", "tenancy", "storage", "llm"],

  entitlementFlag: "resume",

  /**
   * Resume-specific routes.
   * NOTE: /api/resumes is also listed in the ATS manifest because candidate
   * applications need resume upload. When both modules are enabled, the route
   * is mounted once (first registration wins in Express).
   */
  routes: [
    { path: "/api/resumes", module: "../../routes/resumeRoutes" },
  ],

  workers: [],

  crons: [],
};

