const { createHash } = require("node:crypto");

// Pure, read-only planning. Existing account links outrank contact guesses.
// Output excludes names/emails/resume contents and never authorizes a merge.
function auditApplicationIdentities(applications) {
  const groups = new Map();
  const conflicts = [];
  const profiles = new Map();
  const seen = new Set();
  for (const app of applications) {
    const id = String(app._id || "");
    const company = String(app.company?._id || app.company || "");
    if (!id || !company || seen.has(id)) throw new Error("Every application must have a unique ID and company");
    seen.add(id);
    const user = String(app.candidateUser?._id || app.candidateUser || "");
    const profile = String(app.candidateProfile?._id || app.candidateProfile || "");
    const email = String(app.basicDetails?.email || "").trim().toLowerCase();
    const basis = user ? "account" : profile ? "profile" : "unlinked_application";
    const identity = user || profile || id;
    const key = createHash("sha256").update(JSON.stringify([company, basis, identity])).digest("hex");
    if (!groups.has(key)) groups.set(key, { key, company, basis, applicationIds: [], profileIds: new Set() });
    const group = groups.get(key);
    group.applicationIds.push(id);
    if (profile) group.profileIds.add(profile);
    if (profile) {
      const profileKey = JSON.stringify([company, profile]);
      if (!profiles.has(profileKey)) profiles.set(profileKey, []);
      profiles.get(profileKey).push({ key, id });
    }
    // Email is only an internal conflict hint, never a grouping/merge key.
    if (email) conflicts.push({ company, email, key, id });
  }
  const contacts = new Map();
  for (const row of conflicts) {
    const key = JSON.stringify([row.company, row.email]);
    if (!contacts.has(key)) contacts.set(key, []);
    contacts.get(key).push(row);
  }
  const review = [];
  for (const rows of profiles.values()) {
    if (new Set(rows.map((row) => row.key)).size > 1) review.push({ reason: "profile_has_distinct_identity_links", applicationIds: rows.map((row) => row.id).sort() });
  }
  for (const rows of contacts.values()) {
    if (new Set(rows.map((row) => row.key)).size > 1) {
      review.push({ reason: "shared_contact_distinct_identity", applicationIds: rows.map((row) => row.id).sort() });
    }
  }
  for (const group of groups.values()) {
    if (group.profileIds.size > 1) review.push({ reason: "account_has_multiple_profiles", applicationIds: [...group.applicationIds].sort() });
  }
  return {
    version: 1, readOnly: true, applicationCount: applications.length,
    groups: [...groups.values()].map(({ profileIds, ...group }) => ({ ...group, applicationIds: group.applicationIds.sort() })).sort((a, b) => a.key.localeCompare(b.key)),
    review: review.sort((a, b) => a.applicationIds.join().localeCompare(b.applicationIds.join())),
    unlinkedApplications: applications.filter((app) => !app.candidateUser && !app.candidateProfile).length,
  };
}
module.exports = { auditApplicationIdentities };
