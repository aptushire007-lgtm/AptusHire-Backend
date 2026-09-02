// PII guard (BUILD-PLAN Phase 1 guardrail): fixtures are synthetic by
// construction, and this test is the enforcement — it fails the build on
// anything resembling a real email, phone number, or real-world domain in
// test/fixtures/. Résumés in this repo must never be traceable to a person.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

// The only allowed email domain in fixtures.
const ALLOWED_EMAIL = /@example\.com$/i;
// The only allowed phone shape: +91-00000-0NNNN (00000 is an unassigned prefix).
const ALLOWED_PHONE_DIGITS = /^(91)?0{5}0\d{4}$/;
// Real-world services that must never appear, even without a TLD.
const FORBIDDEN_BRANDS = /\b(gmail|yahoo|hotmail|outlook|linkedin|github|gitlab|naukri|indeed|glassdoor|monster|whatsapp|facebook|instagram|twitter)\b/i;

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(txt|json|md)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(FIXTURES_DIR);

test("fixture tree exists and is non-trivial", () => {
  assert.ok(files.length > 0, "no fixture files found");
});

test("every email in fixtures is @example.com", () => {
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)) {
      if (!ALLOWED_EMAIL.test(match[0])) offenders.push(`${path.basename(file)}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `non-synthetic emails found:\n${offenders.join("\n")}`);
});

test("every phone-like number matches the synthetic +91-00000-0NNNN pattern", () => {
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\+?\d[\d\s().-]{8,}\d/g)) {
      const token = match[0].trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(token)) continue; // ISO date, not a phone
      const digits = token.replace(/\D/g, "");
      if (digits.length < 10) continue; // short numeric runs (years, counts)
      if (!ALLOWED_PHONE_DIGITS.test(digits)) offenders.push(`${path.basename(file)}: ${token}`);
    }
    // Bare 10-digit Indian mobile numbers (9xxxxxxxxx) with no separators.
    for (const match of text.matchAll(/(?<!\d)[6-9]\d{9}(?!\d)/g)) {
      offenders.push(`${path.basename(file)}: bare mobile-like ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `non-synthetic phone numbers found:\n${offenders.join("\n")}`);
});

test("no URLs or domains outside example.com; no real-world service brands", () => {
  const offenders = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\bhttps?:\/\/[^\s"')]+|\bwww\.[^\s"')]+/gi)) {
      if (!/example\.com/i.test(match[0])) offenders.push(`${path.basename(file)}: url ${match[0]}`);
    }
    for (const match of text.matchAll(/\b[a-z0-9][a-z0-9-]*\.(com|org|net)\b/gi)) {
      if (!/^example\.(com|org|net)$/i.test(match[0]) && !/@/.test(text.slice(Math.max(0, match.index - 1), match.index))) {
        if (!/example\.com/i.test(match[0])) offenders.push(`${path.basename(file)}: domain ${match[0]}`);
      }
    }
    const brand = text.match(FORBIDDEN_BRANDS);
    // FIXTURES-SPEC.md legitimately names real boards when describing what NOT to do.
    if (brand && path.basename(file) !== "FIXTURES-SPEC.md") {
      offenders.push(`${path.basename(file)}: brand "${brand[0]}"`);
    }
  }
  assert.deepEqual(offenders, [], `real-world domains/brands found:\n${offenders.join("\n")}`);
});
