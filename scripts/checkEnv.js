#!/usr/bin/env node
// Guards against .env.example drifting away from what the code actually reads.
//
// Before this existed, sixteen env vars were read somewhere in the codebase but documented
// nowhere — including BOTH required JWT secrets, so `cp .env.example .env && npm start`
// exited immediately with no clue why. This walks the source, collects every `process.env.X`,
// and diffs it against .env.example in both directions.
//
//   node scripts/checkEnv.js            # report + exit non-zero on undocumented vars
//   node scripts/checkEnv.js --json     # machine-readable, for CI annotations
//
// Exit codes: 0 = in sync · 1 = vars read but undocumented · 2 = could not run.

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const ENV_EXAMPLE = path.join(ROOT, ".env.example");

// Directories that are not our source (or are generated), so their process.env reads
// are not ours to document.
const SKIP_DIRS = new Set(["node_modules", ".git", "uploads", "coverage", "test"]);

// Vars the runtime or tooling provides — never ours to document in .env.example.
const AMBIENT = new Set(["NODE_ENV", "npm_lifecycle_event", "npm_package_version", "TZ", "CI", "PATH", "HOME"]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.name.endsWith(".js")) {
      // Skip this file: its own regexes and doc comments contain `process.env.X`-shaped
      // text, which would otherwise be reported as undocumented vars.
      if (full === __filename) continue;
      out.push(full);
    }
  }
  return out;
}

function readVarsFromSource(files) {
  // Matches process.env.FOO and process.env["FOO"] / ['FOO'].
  const dot = /process\.env\.([A-Z0-9_]+)/g;
  const bracket = /process\.env\[\s*["'`]([A-Z0-9_]+)["'`]\s*\]/g;
  const found = new Map(); // name -> Set of repo-relative files

  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file).replace(/\\/g, "/");
    for (const re of [dot, bracket]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        const name = m[1];
        if (AMBIENT.has(name)) continue;
        if (!found.has(name)) found.set(name, new Set());
        found.get(name).add(rel);
      }
    }
  }
  return found;
}

function readVarsFromExample(text) {
  const declared = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z0-9_]+)\s*=/);
    if (m) declared.add(m[1]);
  }
  return declared;
}

function main() {
  if (!fs.existsSync(ENV_EXAMPLE)) {
    console.error(`[checkEnv] .env.example not found at ${ENV_EXAMPLE}`);
    process.exit(2);
  }

  const used = readVarsFromSource(walk(ROOT));
  const declared = readVarsFromExample(fs.readFileSync(ENV_EXAMPLE, "utf8"));

  const undocumented = [...used.keys()].filter((k) => !declared.has(k)).sort();
  const unused = [...declared].filter((k) => !used.has(k)).sort();

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ undocumented, unused, totalRead: used.size, totalDeclared: declared.size }, null, 2));
    process.exit(undocumented.length ? 1 : 0);
  }

  console.log(`[checkEnv] ${used.size} env var(s) read in source, ${declared.size} declared in .env.example`);

  if (undocumented.length) {
    console.error(`\n[checkEnv] ${undocumented.length} var(s) READ BY CODE but missing from .env.example:`);
    for (const name of undocumented) {
      console.error(`  ${name}\n      ${[...used.get(name)].sort().join("\n      ")}`);
    }
  }

  // Advisory only. A declared-but-unread var is usually a var documented ahead of the code
  // that will consume it, or one consumed by a sibling app — neither is a failure.
  if (unused.length) {
    console.warn(`\n[checkEnv] ${unused.length} var(s) declared in .env.example but not read anywhere (advisory):`);
    console.warn("  " + unused.join(", "));
  }

  if (undocumented.length) {
    console.error("\n[checkEnv] FAILED — document the vars above in .env.example (with the consequence of leaving them unset).");
    process.exit(1);
  }
  console.log("[checkEnv] OK — .env.example covers every env var the code reads.");
}

main();
