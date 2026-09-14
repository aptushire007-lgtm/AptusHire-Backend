/**
 * Module Registry
 *
 * Reads ENABLED_MODULES from the environment and loads only the manifests
 * for enabled modules. Provides methods to mount routes, start workers,
 * and schedule cron jobs — called by server.js and worker.js.
 *
 * Usage:
 *   const registry = require("./module-registry");
 *
 *   // Before express.json() — raw-body webhooks need exact bytes
 *   registry.mountRawWebhooks(app, express);
 *
 *   // After express.json() and middleware
 *   registry.mountRoutes(app);
 *
 *   // After DB connection, when RUN_WORKERS_IN_API is true
 *   registry.startWorkers();
 *   registry.startCrons();
 *
 * Environment:
 *   ENABLED_MODULES=ats,resume,interview   (default: all three)
 *   ENABLED_MODULES=interview              (interview-only deployment)
 *   ENABLED_MODULES=ats,resume             (ATS + resume, no interview)
 */

const path = require("path");
const logger = require("./utils/logger");
const { wrapHandler } = require("./middleware/wrapRouter");

// Available module keys — order matters for route mounting (dependencies first).
const ALL_MODULES = ["ats", "resume", "interview"];

// Parse enabled modules from environment, defaulting to all.
const enabledKeys = (process.env.ENABLED_MODULES || ALL_MODULES.join(","))
  .split(",")
  .map((k) => k.trim().toLowerCase())
  .filter((k) => ALL_MODULES.includes(k));

// Deduplicate (in case of typos like "ats,ats").
const enabledSet = new Set(enabledKeys);

// Load manifests for enabled modules.
const manifests = [];
const mountedPaths = new Set(); // track already-mounted paths to deduplicate

// Every manifest writes its `module`/`handler` paths relative to ITS OWN
// directory (backend/modules/<key>/), not to this file. Node resolves a
// relative require() against the file that calls it, not wherever the string
// came from, so every require below must be re-rooted at the owning
// manifest's directory rather than called as `require(route.module)` directly.
const manifestDirs = new Map();

function requireFromManifest(manifest, relPath) {
  return require(path.resolve(manifestDirs.get(manifest), relPath));
}

for (const key of ALL_MODULES) {
  if (!enabledSet.has(key)) {
    logger.info(`module disabled: ${key}`);
    continue;
  }
  try {
    const manifestId = `./modules/${key}/module.manifest`;
    const manifest = require(manifestId);
    manifests.push(manifest);
    manifestDirs.set(manifest, path.dirname(require.resolve(manifestId)));
    logger.info(`module enabled: ${manifest.displayName} (${key})`);
  } catch (err) {
    logger.error(`failed to load module manifest: ${key}`, {
      err: { message: err.message },
    });
  }
}

/**
 * Mount raw-body webhook routes that must be registered BEFORE express.json().
 * These routes need the exact request bytes for signature verification
 * (e.g., LiveKit webhook JWT, Razorpay HMAC).
 *
 * @param {import('express').Application} app
 * @param {typeof import('express')} express
 */
function mountRawWebhooks(app, express) {
  for (const manifest of manifests) {
    if (!manifest.rawWebhooks) continue;
    for (const wh of manifest.rawWebhooks) {
      try {
        const handler = requireFromManifest(manifest, wh.handler);
        const fn = wh.exportName ? handler[wh.exportName] : handler;
        app.post(
          wh.path,
          express.raw({ type: "application/json", limit: process.env.LIVEKIT_WEBHOOK_BODY_LIMIT || "256kb" }),
          wrapHandler(fn)
        );
        logger.info(`mounted raw webhook: ${wh.path} (${manifest.key})`);
      } catch (err) {
        logger.error(`failed to mount raw webhook: ${wh.path} (${manifest.key})`, {
          err: { message: err.message },
        });
      }
    }
  }
}

/**
 * Mount Express routes for all enabled modules.
 * Called after express.json() and all middleware are registered.
 *
 * @param {import('express').Application} app
 */
function mountRoutes(app) {
  for (const manifest of manifests) {
    // Standard routes
    if (manifest.routes) {
      for (const route of manifest.routes) {
        if (mountedPaths.has(route.path)) {
          // Already mounted by another module (e.g., /api/resumes from both ATS and Resume).
          // Skip to avoid Express double-mounting.
          continue;
        }
        try {
          const router = requireFromManifest(manifest, route.module);
          app.use(route.path, router);
          mountedPaths.add(route.path);
        } catch (err) {
          logger.error(`failed to mount route: ${route.path} (${manifest.key})`, {
            err: { message: err.message },
          });
        }
      }
    }

    // Conditional routes (feature-flagged within a module)
    if (manifest.conditionalRoutes) {
      for (const group of manifest.conditionalRoutes) {
        let enabled = false;
        try {
          enabled = group.condition();
        } catch {
          enabled = false;
        }
        if (!enabled) continue;
        for (const route of group.routes) {
          if (mountedPaths.has(route.path)) continue;
          try {
            const router = requireFromManifest(manifest, route.module);
            app.use(route.path, router);
            mountedPaths.add(route.path);
          } catch (err) {
            logger.error(`failed to mount conditional route: ${route.path} (${manifest.key})`, {
              err: { message: err.message },
            });
          }
        }
      }
    }
  }

  const count = mountedPaths.size;
  logger.info(`module registry: mounted ${count} route(s) from ${manifests.length} module(s)`);
}

/**
 * Start BullMQ workers for all enabled modules.
 * Called after DB connection, only when RUN_WORKERS_IN_API is true
 * or from the dedicated worker.js process.
 */
function startWorkers() {
  for (const manifest of manifests) {
    if (!manifest.workers) continue;
    for (const w of manifest.workers) {
      try {
        const mod = requireFromManifest(manifest, w.module);
        const startFn = mod[w.start];
        if (typeof startFn === "function") {
          startFn();
          logger.info(`started worker: ${w.start} (${manifest.key})`);
        }
      } catch (err) {
        logger.error(`failed to start worker: ${w.start} (${manifest.key})`, {
          err: { message: err.message },
        });
      }
    }
  }
}

/**
 * Start cron jobs for all enabled modules.
 * Called after DB connection, only when RUN_WORKERS_IN_API is true
 * or from the dedicated worker.js process.
 */
function startCrons() {
  for (const manifest of manifests) {
    if (!manifest.crons) continue;
    for (const c of manifest.crons) {
      // Some crons have their own condition (e.g., assessment engine flag)
      if (c.condition) {
        let enabled = false;
        try {
          enabled = c.condition();
        } catch {
          enabled = false;
        }
        if (!enabled) continue;
      }
      try {
        const mod = requireFromManifest(manifest, c.module);
        const startFn = mod[c.start];
        if (typeof startFn === "function") {
          startFn();
          logger.info(`started cron: ${c.start} (${manifest.key})`);
        }
      } catch (err) {
        logger.error(`failed to start cron: ${c.start} (${manifest.key})`, {
          err: { message: err.message },
        });
      }
    }
  }
}

/**
 * Check if a specific module is enabled.
 * @param {string} key - Module key (ats, resume, interview).
 * @returns {boolean}
 */
function isModuleEnabled(key) {
  return enabledSet.has(key);
}

/**
 * Get the list of enabled module keys.
 * @returns {string[]}
 */
function getEnabledModules() {
  return [...enabledSet];
}

module.exports = {
  mountRawWebhooks,
  mountRoutes,
  startWorkers,
  startCrons,
  isModuleEnabled,
  getEnabledModules,
  ALL_MODULES,
};

