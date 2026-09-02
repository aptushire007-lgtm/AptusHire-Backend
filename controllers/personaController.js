// HTTP layer for interviewer personas. Admin-only and tenant-scoped; the lifecycle rules live in
// services/personaService and models/PersonaProfile.
//
// Approval is the sanctioned human-in-the-loop boundary, the same one the rubric has and for the
// same reason: a persona sets the conditions every candidate for this tenant is interviewed under
// (voice, name, how long the interviewer waits before treating silence as an answer). The
// auditLog middleware records it via req.audit — who approved which version, when.
//
// Note what these routes CANNOT do: they cannot change a single question, a weight, a threshold
// or a score. A persona is a renderer, not an author.

const personaService = require("../services/personaService");

// GET /api/personas — every version, plus what a session would actually resolve to right now.
async function listPersonas(req, res) {
  const versions = await personaService.listForCompany(req.user.company);
  const active = versions.find((p) => p.status === "approved") || null;
  res.json({
    active,
    versions,
    // Surfaced explicitly so "we haven't set one up" never looks like a configured choice.
    effective: active ? { source: "tenant" } : { source: "default", ...personaService.defaultPersona() },
  });
}

// POST /api/personas — create the next draft version for a key.
async function createPersona(req, res) {
  const persona = await personaService.createDraft(req.user.company, req.body || {});
  req.audit = {
    action: "persona.create",
    resourceType: "PersonaProfile",
    resourceId: persona._id,
    meta: { key: persona.key, version: persona.version },
  };
  res.status(201).json(persona);
}

// PATCH /api/personas/:id — drafts only. An approved persona is frozen; edit means new version.
async function updatePersona(req, res) {
  const persona = await personaService.updateDraft(req.params.id, req.user.company, req.body || {});
  req.audit = {
    action: "persona.update",
    resourceType: "PersonaProfile",
    resourceId: persona._id,
    meta: { key: persona.key, version: persona.version },
  };
  res.json(persona);
}

// POST /api/personas/:id/approve — freeze this version, archive the one it replaces.
async function approvePersona(req, res) {
  const persona = await personaService.approve(req.params.id, req.user.company, req.user);
  req.audit = {
    action: "persona.approve",
    resourceType: "PersonaProfile",
    resourceId: persona._id,
    meta: {
      key: persona.key,
      version: persona.version,
      name: persona.name,
      voice: persona.voice?.model || "(deployment default)",
      patience: persona.patience,
      frozenAt: persona.frozenAt,
    },
  };
  res.json(persona);
}

module.exports = { listPersonas, createPersona, updatePersona, approvePersona };
