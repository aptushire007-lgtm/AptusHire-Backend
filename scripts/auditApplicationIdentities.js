// Usage: node scripts/auditApplicationIdentities.js path/to/application-export.json
// Deliberately no database dependency, write mode, credentials or side effects.
const { readFileSync } = require("node:fs");
const { auditApplicationIdentities } = require("../utils/applicationIdentityAudit");
try {
  if (process.argv.length !== 3) throw new Error("Provide one local JSON array of applications; no database is accessed.");
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  if (!Array.isArray(input)) throw new Error("Input must be a JSON array");
  process.stdout.write(JSON.stringify(auditApplicationIdentities(input), null, 2) + "\n");
} catch (error) {
  process.stderr.write(`Identity audit failed: ${error.message}\n`);
  process.exitCode = 1;
}
