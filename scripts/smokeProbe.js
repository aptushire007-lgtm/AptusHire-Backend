#!/usr/bin/env node
// Live end-to-end smoke of the Claim → Probe → Verdict loop (BUILD-PLAN
// Phase 8 gates that need a real database):
//
//   approved rubric (unequal weights) → live evidence assessment computes
//   unverifiedHighWeightClaims → interview session → probes generated and
//   REQUIRED in the plan → probe asked first, covered, interview ends EARLY
//   (isClosing finally works) → finalisation assesses verdicts (verbatim
//   answer quote, code-verified) → ClaimGraph write-back → post-interview
//   rescore persists a SECOND assessment with a higher score and a different
//   reproducibilityHash → report JSON + PDF render the claim-verification
//   section with both quotes.
//
// The LLM layer is stubbed IN-PROCESS with canned, schema-valid responses —
// zero network, zero spend — while every real seam runs: Mongo, tenant
// scoping, span verification, probe sanitiser, closing logic, scorer.
//
//   node scripts/smokeProbe.js

require("dotenv").config();
require("../config/dnsOverride").applyDnsOverride();
process.env.OPENROUTER_API_KEY = "sk-stubbed-never-used";
process.env.LLM_REPLAY = "";
process.env.LLM_RECORD = "";
process.env.RUBRIC_ENGINE_ENABLED = "true";
process.env.CLAIM_ENGINE_ENABLED = "true";
process.env.PROBE_ENGINE_ENABLED = "true";
process.env.ATS_QA_GATE = "monitor";
process.env.QA_COUNTERFACTUAL_SAMPLE_RATE = "0";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const mongoose = require("mongoose");
const Job = require("../models/Job");
const Candidate = require("../models/Candidate");
const RoleRubric = require("../models/RoleRubric");
const ClaimGraph = require("../models/ClaimGraph");
const AtsAssessment = require("../models/AtsAssessment");
const InterviewSession = require("../models/InterviewSession");
const rubricService = require("../services/rubricService");
const evidenceAtsService = require("../services/evidenceAtsService");
const aiInterview = require("../services/aiInterviewService");
const llm = require("../services/llmService");
const usageService = require("../services/usageService");
const tenantContext = require("../utils/tenantContext");
const { normalizeText } = require("../utils/textNormalize");
const defense = require("../services/resumeDefenseService");
const { probePhrasingIssues } = require("../utils/probePrompts");

const RESUME_RAW = `ROHAN PROBESMITH
Pune, Maharashtra | rohan.probesmith@example.com | +91-00000-00084

PROFESSIONAL SUMMARY
Backend engineer with five years building Node.js services.

SKILLS
- Node.js, Express, MongoDB, REST APIs

EXPERIENCE
Senior Backend Engineer — Deccan Systems, Pune
January 2021 to June 2025
- Built REST APIs in Node.js and Express for the clinic platform.
- Modelled patient data in MongoDB across three services.

EDUCATION
Bachelor of Engineering — Sahyadri Institute of Technology, 2019
`;

let questionCounter = 0;

function stubGenerateJSON({ system, prompt }) {
  // Claim extraction (Phase 5)
  if (/information-extraction engine/i.test(system)) {
    return {
      data: {
        claims: [
          { type: "skill", subject: "candidate", predicate: "built", object: "REST APIs in Node.js",
            normalized: { skill: "node.js", years: 0, level: "", domain: "", startDate: "", endDate: "" },
            quotes: ["Built REST APIs in Node.js and Express for the clinic platform."], confidence: 0.9, specificity: "specific" },
          { type: "skill", subject: "candidate", predicate: "modelled data in", object: "MongoDB",
            normalized: { skill: "mongodb", years: 0, level: "", domain: "", startDate: "", endDate: "" },
            quotes: ["Modelled patient data in MongoDB across three services."], confidence: 0.85, specificity: "specific" },
          { type: "employment_period", subject: "Deccan Systems", predicate: "employed", object: "Senior Backend Engineer",
            normalized: { skill: "", years: 0, level: "senior", domain: "", startDate: "January 2021", endDate: "June 2025" },
            quotes: ["January 2021 to June 2025"], confidence: 0.95, specificity: "specific" },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 100 }, model: "stub-extract", cached: false,
    };
  }
  // Evidence matching (Phase 6)
  if (/precise evidence auditor/i.test(system)) {
    return {
      data: {
        findings: [
          { criterionId: "c1", status: "satisfied", supportingClaimIds: ["k1"], reasoning: "Direct API-building evidence.", confidence: 0.85 },
          { criterionId: "c2", status: "satisfied", supportingClaimIds: ["k3"], reasoning: "Dated senior tenure.", confidence: 0.85 },
          { criterionId: "c3", status: "satisfied", supportingClaimIds: ["k2"], reasoning: "Data modelling stated.", confidence: 0.8 },
        ],
      },
      usage: { inputTokens: 100, outputTokens: 80 }, model: "stub-match", cached: false,
    };
  }
  // QA critic (Phase 7)
  if (/adversarial evidence auditor/i.test(system)) {
    return { data: { refuted: [] }, usage: { inputTokens: 50, outputTokens: 10 }, model: "stub-critic", cached: false };
  }
  // Probe generation (Phase 8.1) — deliberately includes ONE accusatory probe
  // to prove the sanitiser drops it in a live run.
  if (/design interview questions that test specific resume claims/i.test(system)) {
    const ids = [...prompt.matchAll(/claimId "([^"]+)"/g)].map((m) => m[1]);
    const probes = ids.map((id) => ({
      claimId: id,
      question: `Walk me through how you built the REST APIs for the clinic platform — what did you own end to end?`,
      whatWouldVerify: "Concrete routing/auth/error-handling decisions and trade-offs only the builder would know.",
      whatWouldContradict: "Cannot describe the basic structure of the APIs or their consumers.",
    }));
    // Accusatory variant FIRST so the sanitiser must reject it on phrasing
    // (not as a duplicate) and keep the neutral one.
    probes.unshift({ claimId: ids[0], question: "You claim you built these APIs — prove it.", whatWouldVerify: "x", whatWouldContradict: "y" });
    return { data: { probes }, usage: { inputTokens: 80, outputTokens: 60 }, model: "stub-probe", cached: false };
  }
  // Verdict assessment (Phase 8.4) — verified, quoting VERBATIM from the answer.
  if (/auditing whether interview answers bear out/i.test(system)) {
    const ids = [...prompt.matchAll(/claimId "([^"]+)"/g)].map((m) => m[1]);
    const answers = [...prompt.matchAll(/CANDIDATE ANSWER \(verbatim\):\n"""([\s\S]*?)"""/g)].map((m) => m[1]);
    return {
      data: {
        verdicts: ids.map((id, i) => ({
          claimId: id,
          verdict: "verified",
          reasoning: "Described the middleware chain and versioning decisions in first-hand detail.",
          answerQuote: (answers[i] || "").slice(0, 40),
        })),
      },
      usage: { inputTokens: 90, outputTokens: 40 }, model: "stub-verdict", cached: false,
    };
  }
  // Interviewer (plan / question / evaluation share INTERVIEWER_SYSTEM)
  if (/produce an interview plan/i.test(prompt)) {
    return {
      data: { role: "Backend Engineer", difficultyEstimate: "medium", topics: ["APIs", "MongoDB"], focusAreas: ["Node.js"], summary: "Probe-driven screening." },
      usage: { inputTokens: 60, outputTokens: 40 }, model: "stub-plan", cached: false,
    };
  }
  if (/Evaluate this candidate for the role/i.test(prompt)) {
    return {
      data: {
        overallScore: 74, communication: 72, technicalKnowledge: 78, problemSolving: 70,
        strengths: ["Concrete API ownership"], weaknesses: ["Limited infra depth"], missingSkills: [],
        recommendation: "hire", summary: "Solid, verified backend experience.",
      },
      usage: { inputTokens: 120, outputTokens: 80 }, model: "stub-eval", cached: false,
    };
  }
  if (/score the candidate's most recent answer/i.test(prompt)) {
    const probeMatch = prompt.match(/- probeId "([^"]+)": (.+)/);
    if (probeMatch) {
      return {
        data: { answerScore: 70, difficulty: "medium", topic: "resume claims", question: probeMatch[2], probeId: probeMatch[1], isClosing: false },
        usage: { inputTokens: 80, outputTokens: 40 }, model: "stub-question", cached: false,
      };
    }
    if (/you may close/i.test(prompt)) {
      return {
        data: { answerScore: 76, difficulty: "medium", topic: "", question: "That's everything I wanted to cover — thank you, the team will be in touch.", probeId: "", isClosing: true },
        usage: { inputTokens: 80, outputTokens: 30 }, model: "stub-question", cached: false,
      };
    }
    questionCounter += 1;
    return {
      data: { answerScore: 68, difficulty: "medium", topic: "general", question: `Stub question ${questionCounter}: how do you approach schema design?`, probeId: "", isClosing: false },
      usage: { inputTokens: 80, outputTokens: 40 }, model: "stub-question", cached: false,
    };
  }
  throw new Error("Unexpected LLM call in smokeProbe: " + String(system).slice(0, 60));
}

let passed = 0;
function ok(label) {
  passed += 1;
  console.log(`  ✓ ${label}`);
}

async function waitFor(fn, label, timeoutMs = 15000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  const companyId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const ids = {};

  const origGenerate = llm.generateJSON;
  const origEnabled = llm.isEnabled;
  const origRecord = usageService.recordUsage;
  llm.generateJSON = async (req) => stubGenerateJSON(req);
  llm.isEnabled = () => true;
  usageService.recordUsage = async () => {};

  try {
    await tenantContext.runAsSystem(async () => {
      // --- setup: job with length overrides + approved rubric with an
      //     UNEQUAL-weight criterion so a high-weight probe target exists ---
      const job = await Job.create({
        company: companyId,
        title: "SMOKE Probe Backend Engineer",
        description: "Throwaway job created by scripts/smokeProbe.js.",
        requiredSkills: ["node.js", "mongodb"],
        minExperienceYears: 4,
        atsThreshold: 60,
        interviewMinQuestions: 3,
        interviewMaxQuestions: 6,
      });
      ids.job = job._id;

      const draft = await RoleRubric.create({
        job: job._id,
        company: companyId,
        version: 1,
        status: "draft",
        sourceHash: crypto.createHash("sha256").update(job.description).digest("hex"),
        criteria: [
          { id: "c1", label: "Node.js API experience", kind: "must_have", weight: 0.6, rationale: "Core of the role." },
          { id: "c2", label: "Senior backend tenure", kind: "must_have", weight: 0.2, rationale: "Seniority requirement." },
          { id: "c3", label: "MongoDB data modelling", kind: "must_have", weight: 0.2, rationale: "Primary datastore." },
        ],
        thresholds: { advance: 60, review: 45 },
        compiledBy: { engine: "fallback", at: new Date() },
      });
      await rubricService.approve(draft._id, companyId, { _id: userId });
      ok("setup: job (min 3 / max 6 questions) + approved unequal-weight rubric");

      // --- candidate + live pre-interview assessment ---
      const { text, artifacts } = normalizeText(RESUME_RAW);
      const hostility = defense.analyze({ text, blocks: [], artifacts });
      const candidate = await Candidate.create({
        job: job._id,
        company: companyId,
        basicDetails: { name: "Rohan Probesmith", email: "rohan.probesmith@example.com", phone: "+91-00000-00084" },
        resumePath: "smoke/none.pdf",
        resumeText: text,
        resumeHash: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
        hostility,
        consent: { aiProcessing: true, dataProcessing: true, at: new Date() },
      });
      ids.candidate = candidate._id;

      const pre = await evidenceAtsService.runEvidenceAssessment(candidate, job, { mode: "live" });
      assert.equal(pre.stage, "pre_interview");
      assert.ok(
        pre.unverifiedHighWeightClaims.some((u) => u.claimId === "k1"),
        "the high-weight, self-reported, unquantified claim must be probe-worthy"
      );
      ok(`pre-interview assessment scored ${pre.overallScore} (${pre.band}); k1 flagged as unverified high-weight`);

      // --- interview session + probe-driven interview ---
      const session = await InterviewSession.create({
        candidate: candidate._id,
        job: job._id,
        company: companyId,
        tokenHash: crypto.randomBytes(24).toString("hex"),
        interviewAt: new Date(),
        expiresAt: new Date(Date.now() + 48 * 3600 * 1000),
      });
      ids.session = session._id;

      await aiInterview.beginInterview(session);
      const ai = session.aiInterview;
      assert.equal(ai.engine, "ai");
      assert.equal(ai.minQuestions, 3);
      assert.equal(ai.maxQuestions, 6);
      assert.equal(ai.probes.length, 1, "one high-weight claim ⇒ one probe (accusatory duplicate dropped)");
      assert.equal(ai.probes[0].claimId, "k1");
      assert.deepEqual(probePhrasingIssues(ai.probes[0].question), [], "the surviving probe must be neutral");
      ok("ACCEPTANCE GATE: probes generated into the plan; the accusatory variant was dropped in code");

      const q1 = ai.turns.find((t) => t.kind === "question");
      assert.equal(q1.probeId, "k1", "the probe is asked (stub prioritises required coverage)");
      assert.equal(ai.probes[0].status, "asked");
      ok("ACCEPTANCE GATE: the probe question is demonstrably asked and marked covered");

      // --- answers: probe answer first, then two more; interview must end EARLY ---
      await aiInterview.submitAnswer(
        session,
        "I owned the Express routing layer end to end: an auth middleware chain with JWT rotation, versioned routes under /v2, and a central error envelope. The trickiest part was idempotent retries on the booking endpoints."
      );
      await aiInterview.submitAnswer(
        session,
        "For schema design I start from the read patterns: appointments are embedded in the patient document up to a cap, then spill to a collection with a compound index on (clinic, date)."
      );
      const finalState = await aiInterview.submitAnswer(
        session,
        "I keep indexes matched to the hot queries and verify with explain plans; we caught a collection scan on the reporting path that way."
      );
      assert.equal(finalState.completed, true, "the interview must complete");
      assert.equal(session.aiInterview.questionCount, 3, "ended at 3 questions");
      assert.ok(session.aiInterview.questionCount < session.aiInterview.maxQuestions, "…which is EARLY (max 6)");
      assert.equal(session.aiInterview.turns[session.aiInterview.turns.length - 1].kind, "closing");
      ok("ACCEPTANCE GATE: all probes covered + min reached ⇒ isClosing ends the interview early (3/6)");

      // --- finalisation (detached): verdicts → write-back → rescore ---
      const done = await waitFor(async () => {
        const s = await InterviewSession.findById(session._id);
        const postA = await AtsAssessment.findOne({ candidate: candidate._id, company: companyId, stage: "post_interview" });
        return s.aiInterview.evaluation?.generatedAt && s.aiInterview.probes[0]?.status === "assessed" && postA ? { s, postA } : null;
      }, "finalisation (evaluation + verdicts + rescore)");

      const probe = done.s.aiInterview.probes[0];
      assert.equal(probe.verdict, "verified");
      assert.ok(probe.answerQuote && done.s.aiInterview.turns.some((t) => t.role === "candidate" && t.text.includes(probe.answerQuote)),
        "the verdict's answer quote is verbatim from the transcript");
      ok("ACCEPTANCE GATE: verdict assessed with a code-verified verbatim transcript quote");

      const graph = await ClaimGraph.findOne({ candidate: candidate._id, company: companyId }).sort({ createdAt: -1 });
      assert.equal(graph.claims.find((c) => c.id === "k1").verificationStatus, "verified_in_interview");
      ok("ACCEPTANCE GATE: verdict written back to the ClaimGraph (k1 → verified_in_interview)");

      const post = done.postA;
      assert.ok(post.overallScore > pre.overallScore, `post (${post.overallScore}) must exceed pre (${pre.overallScore})`);
      assert.notEqual(post.reproducibilityHash, pre.reproducibilityHash, "post hash folds in the claim state");
      const preStill = await AtsAssessment.findById(pre._id);
      assert.equal(preStill.overallScore, pre.overallScore, "the pre-interview assessment is untouched");
      ok(`ACCEPTANCE GATE: post-interview rescore ${pre.overallScore} → ${post.overallScore} persisted as a SECOND assessment`);

      // --- report + PDF render the loop (through the real endpoint handler) ---
      const controller = require("../controllers/candidateController");
      let report;
      await controller.getInterviewReport(
        { params: { id: String(candidate._id) }, user: { company: companyId } },
        { status: () => ({ json: (x) => (report = x) }), json: (x) => (report = x) }
      );
      assert.ok(report.claimVerification, "report carries the claim-verification block");
      assert.equal(report.claimVerification.probes[0].verdict, "verified");
      assert.ok(report.claimVerification.probes[0].resumeQuote && report.claimVerification.probes[0].answerQuote, "both quotes present");
      assert.equal(report.claimVerification.scoreDelta.delta, post.overallScore - pre.overallScore);
      const { buildReportPdf } = require("../services/interviewReportPdf");
      const pdf = buildReportPdf(report);
      assert.ok(Buffer.isBuffer(pdf) && pdf.length > 1000, "PDF renders");
      ok("ACCEPTANCE GATE: report JSON + PDF render claim verification with both quotes and the score delta");
    });

    console.log(`\n[smokeProbe] PASS — ${passed} checks green.`);
  } finally {
    llm.generateJSON = origGenerate;
    llm.isEnabled = origEnabled;
    usageService.recordUsage = origRecord;
    await tenantContext.runAsSystem(async () => {
      if (ids.session) await InterviewSession.deleteOne({ _id: ids.session });
      if (ids.candidate) {
        await AtsAssessment.deleteMany({ candidate: ids.candidate });
        await ClaimGraph.deleteMany({ candidate: ids.candidate });
        // Same list smokeEvidence cleans. Missing this one is how a smoke run
        // left an unresolvable ghost card in the demo tenant's review queue.
        await require("../models/ReviewItem").deleteMany({ candidate: ids.candidate });
        await Candidate.deleteOne({ _id: ids.candidate });
      }
      if (ids.job) {
        await RoleRubric.deleteMany({ job: ids.job });
        await Job.deleteOne({ _id: ids.job });
      }
      const AdminNotification = require("../models/AdminNotification");
      await AdminNotification.deleteMany({ company: companyId }).catch(() => {});
    });
    await mongoose.disconnect();
  }
}

main().catch((err) => {
  console.error("\n[smokeProbe] FAIL:", err.message);
  process.exit(1);
});
