const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "to", "of", "in", "on",
  "for", "with", "as", "at", "by", "from", "is", "are", "was", "were", "be", "been",
  "being", "this", "that", "these", "those", "it", "its", "we", "you", "your", "our",
  "will", "shall", "should", "would", "can", "could", "may", "might", "must", "not",
  "have", "has", "had", "do", "does", "did", "into", "than", "such", "etc", "who",
  "what", "which", "their", "they", "them", "us", "about", "across", "per",
]);

const WEIGHTS = {
  skillsMatch: 0.3,
  keywordMatch: 0.2,
  experienceMatch: 0.2,
  educationMatch: 0.1,
  projectsMatch: 0.1,
  certificationMatch: 0.1,
};

function normalize(str) {
  return (str || "").toLowerCase();
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Plain substring checks give false positives for short tokens (e.g. skill
// "Go" matching inside "google" or "going"), so require word boundaries.
function containsWholeWord(haystack, needle) {
  if (!needle) return false;
  const pattern = new RegExp(`(?<![a-z0-9])${escapeRegex(needle)}(?![a-z0-9])`, "i");
  return pattern.test(haystack);
}

function tokenize(str) {
  return normalize(str)
    .split(/[^a-z0-9+.#]+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function uniqueKeywords(str, limit = 40) {
  const counts = new Map();
  for (const word of tokenize(str)) {
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([word]) => word);
}

function parseDateLoose(value, fallback) {
  if (!value) return fallback;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime())) return direct;
  const yearMatch = String(value).match(/\d{4}/);
  if (yearMatch) return new Date(`${yearMatch[0]}-01-01`);
  return fallback;
}

function computeExperienceYears(experience) {
  const now = new Date();
  let totalMs = 0;
  for (const entry of experience || []) {
    const start = parseDateLoose(entry.startDate, null);
    if (!start) continue;
    const end = entry.currentlyWorking ? now : parseDateLoose(entry.endDate, now);
    const durationMs = end.getTime() - start.getTime();
    if (durationMs > 0) totalMs += durationMs;
  }
  return totalMs / (1000 * 60 * 60 * 24 * 365.25);
}

function scoreSkillsMatch(job, candidate, resumeTextLower) {
  const required = (job.requiredSkills || []).map((s) => normalize(s)).filter(Boolean);
  if (required.length === 0) return { score: 100, missingSkills: [] };

  const candidateSkills = new Set((candidate.skills || []).map((s) => normalize(s)));
  const missingSkills = [];
  let matched = 0;

  for (const skill of required) {
    const inSkillsList = candidateSkills.has(skill);
    const inResumeText = containsWholeWord(resumeTextLower, skill);
    if (inSkillsList || inResumeText) {
      matched += 1;
    } else {
      missingSkills.push(skill);
    }
  }

  return { score: Math.round((matched / required.length) * 100), missingSkills };
}

function scoreKeywordMatch(job, resumeTextLower) {
  const keywords = uniqueKeywords(`${job.description || ""} ${job.requirements || ""}`);
  if (keywords.length === 0) return 100;
  const matched = keywords.filter((kw) => containsWholeWord(resumeTextLower, kw)).length;
  return Math.round((matched / keywords.length) * 100);
}

function scoreExperienceMatch(job, candidate) {
  const required = job.minExperienceYears || 0;
  if (required <= 0) return 100;
  const candidateYears = computeExperienceYears(candidate.experience);
  return Math.max(0, Math.min(100, Math.round((candidateYears / required) * 100)));
}

function scoreEducationMatch(job, candidate) {
  const required = normalize(job.requiredEducation);
  if (!required) return 100;

  const requiredWords = tokenize(required);
  if (requiredWords.length === 0) return 100;

  const candidateEducationText = (candidate.education || [])
    .map((e) => `${e.degree || ""} ${e.fieldOfStudy || ""} ${e.institution || ""}`)
    .join(" ");
  const candidateWords = new Set(tokenize(candidateEducationText));

  const matched = requiredWords.filter((w) => candidateWords.has(w)).length;
  return Math.round((matched / requiredWords.length) * 100);
}

function scoreProjectsMatch(job, candidate) {
  const required = (job.requiredSkills || []).map((s) => normalize(s)).filter(Boolean);
  const projects = candidate.projects || [];

  if (required.length === 0) {
    return projects.length > 0 ? 100 : 50;
  }
  if (projects.length === 0) return 0;

  const projectText = normalize(
    projects.map((p) => `${p.title || ""} ${p.description || ""} ${p.techStack || ""}`).join(" ")
  );
  const matched = required.filter((skill) => containsWholeWord(projectText, skill)).length;
  return Math.round((matched / required.length) * 100);
}

function scoreCertificationMatch(job, candidate) {
  const jobText = normalize(`${job.description || ""} ${job.requirements || ""}`);
  const certificationRequired = jobText.includes("certificat");
  const hasCertificates = (candidate.certificates || []).length > 0;

  if (!certificationRequired) return 100;
  return hasCertificates ? 100 : 0;
}

function computeAtsScore(job, candidate, resumeText) {
  const resumeTextLower = normalize(resumeText);

  const { score: skillsMatch, missingSkills } = scoreSkillsMatch(job, candidate, resumeTextLower);
  const keywordMatch = scoreKeywordMatch(job, resumeTextLower);
  const experienceMatch = scoreExperienceMatch(job, candidate);
  const educationMatch = scoreEducationMatch(job, candidate);
  const projectsMatch = scoreProjectsMatch(job, candidate);
  const certificationMatch = scoreCertificationMatch(job, candidate);

  const overallScore = Math.round(
    skillsMatch * WEIGHTS.skillsMatch +
      keywordMatch * WEIGHTS.keywordMatch +
      experienceMatch * WEIGHTS.experienceMatch +
      educationMatch * WEIGHTS.educationMatch +
      projectsMatch * WEIGHTS.projectsMatch +
      certificationMatch * WEIGHTS.certificationMatch
  );

  const threshold = typeof job.atsThreshold === "number" ? job.atsThreshold : 60;
  const decision = overallScore >= threshold ? "pass" : "fail";

  return {
    skillsMatch,
    experienceMatch,
    educationMatch,
    projectsMatch,
    certificationMatch,
    keywordMatch,
    missingSkills,
    overallScore,
    threshold,
    decision,
    scoredAt: new Date(),
  };
}

module.exports = { computeAtsScore };
