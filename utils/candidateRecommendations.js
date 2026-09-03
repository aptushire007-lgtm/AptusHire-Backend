const DAY_MS = 24 * 60 * 60 * 1000;

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, " ")
    .trim();
}

function terms(values) {
  return [...new Set((values || []).map(normalize).flatMap((value) => value.split(/\s+/)).filter((value) => value.length >= 2))];
}

function candidateSignals({ profile, resumes }) {
  const latest = (resumes || []).find((resume) => resume.isDefault) || resumes?.[0];
  const skills = [
    ...(profile?.skills || []),
    ...(profile?.experience || []).flatMap((entry) => entry.skills || []),
    ...(latest?.parsedSnapshot?.skills || []),
    ...(latest?.tags || []),
    ...(latest?.parsedSnapshot?.suggestedRoles || []),
    profile?.headline,
    profile?.bio,
  ];
  return {
    exactSkills: new Set((skills || []).map(normalize).filter(Boolean)),
    words: new Set(terms(skills)),
    experienceYears: Number(latest?.parsedSnapshot?.experienceYears || 0),
  };
}

function jobText(job) {
  return normalize([
    job.title,
    job.department,
    job.requiredSkills?.join(" "),
    job.requirements,
    job.description,
  ].join(" "));
}

function scoreJob(job, signals, now = Date.now()) {
  const required = (job.requiredSkills || []).map(normalize).filter(Boolean);
  const matchedRequired = required.filter((skill) => signals.exactSkills.has(skill) || jobText(job).includes(skill));
  const textWords = new Set(jobText(job).split(/\s+/));
  const matchingWords = [...signals.words].filter((word) => textWords.has(word));
  const skillScore = required.length ? (matchedRequired.length / required.length) * 60 : 0;
  const domainScore = Math.min(25, matchingWords.length * 5);
  const experienceScore = job.minExperienceYears == null || signals.experienceYears >= Number(job.minExperienceYears) ? 10 : 3;
  const ageDays = Math.max(0, (now - new Date(job.createdAt || 0).getTime()) / DAY_MS);
  const recencyScore = Math.max(0, 5 - Math.min(5, ageDays / 30));
  return {
    score: skillScore + domainScore + experienceScore + recencyScore,
    matchedSkills: matchedRequired,
  };
}

function rankRecommendedJobs(jobs, { profile, resumes, now = Date.now(), limit = 5 } = {}) {
  const signals = candidateSignals({ profile, resumes });
  return jobs
    .map((job) => ({ job, ranking: scoreJob(job, signals, now) }))
    .sort((a, b) => b.ranking.score - a.ranking.score || new Date(b.job.createdAt || 0) - new Date(a.job.createdAt || 0))
    .slice(0, limit)
    .map(({ job, ranking }) => ({ ...job, recommendationScore: Math.round(ranking.score), matchedSkills: ranking.matchedSkills }));
}

module.exports = { rankRecommendedJobs, scoreJob };
