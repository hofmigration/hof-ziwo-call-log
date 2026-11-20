// 3-people.js — which HubSpot user made each Ziwo call.
//
// Each Ziwo user is matched to a HubSpot user, in this order (the first that works wins):
//   1. config.js AGENT_OVERRIDES, by hand
//   2. the same email address
//   3. learned: the Ziwo app has already logged this person's calls in HubSpot, all under
//      one HubSpot user
//   4. the same name before the @ ("saadaman" = saadaman@hofmigration.com)
//   5. the same first and last name, only when exactly one HubSpot user has it
// Nothing is ever guessed: no match means the calls are not logged and the email says so.
const { SETTINGS } = require("./config");

const norm = (s) => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
  .replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
const localPart = (s) => String(s || "").toLowerCase().split("@")[0].replace(/[^a-z0-9]/g, "");
const fullName = (z) => `${z.firstName || ""} ${z.lastName || ""}`.replace(/\s+/g, " ").trim();

// one key per value; a key two people share is kept as null (= ambiguous, never used)
function uniqueIndex(owners, keyOf) {
  const m = new Map();
  for (const o of owners) { const k = keyOf(o); if (k) m.set(k, m.has(k) ? null : o); }
  return m;
}

// From calls the Ziwo app put in HubSpot (same Ziwo call id on both sides): which HubSpot
// user each Ziwo user's calls were logged under. Trusted when at least 2 calls and 80% agree.
function learn(pairs) {
  const tally = new Map();
  for (const { agentId, ownerId } of pairs) {
    if (!agentId || !ownerId) continue;
    if (!tally.has(agentId)) tally.set(agentId, new Map());
    const t = tally.get(agentId);
    t.set(ownerId, (t.get(ownerId) || 0) + 1);
  }
  const out = new Map();
  for (const [agentId, t] of tally) {
    const total = [...t.values()].reduce((a, b) => a + b, 0);
    const [ownerId, count] = [...t.entries()].sort((a, b) => b[1] - a[1])[0];
    out.set(agentId, { ownerId, count, total, trusted: count >= 2 && count / total >= 0.8 });
  }
  return out;
}

// ziwoUsers: [{ id, firstName, lastName, username, email }]; owners: HubSpot users
// -> Map ziwo id -> { ownerId, ownerName, how, note, skip }
function matchAgents(ziwoUsers, owners, learned = new Map(), overrides = SETTINGS.AGENT_OVERRIDES) {
  const byId = new Map(owners.map((o) => [o.id, o]));
  const byEmail = uniqueIndex(owners, (o) => o.email);
  const byLocal = uniqueIndex(owners, (o) => localPart(o.email));
  const byName = uniqueIndex(owners, (o) => norm(o.name));
  const hand = new Map(Object.entries(overrides || {}).map(([k, v]) => [String(k).trim().toLowerCase(), String(v).trim()]));
  const result = new Map();

  for (const z of ziwoUsers) {
    const name = fullName(z);
    const notes = [];
    let owner = null, how = "";

    const byHand = [z.id, z.username, z.email, name].filter(Boolean).map((k) => hand.get(String(k).toLowerCase())).find(Boolean);
    if (byHand) {
      if (byHand.toLowerCase() === "skip") { result.set(z.id, { ownerId: "", ownerName: "", how: "Skipped in config.js", note: "", skip: true }); continue; }
      owner = byEmail.get(byHand.toLowerCase()) || byId.get(byHand) || null;
      if (owner) how = "Set by hand in config.js";
      else notes.push(`config.js names ${byHand}, which is not an active HubSpot user`);
    }
    if (!owner && z.email && byEmail.get(z.email)) { owner = byEmail.get(z.email); how = "Same email"; }
    const l = learned.get(z.id);
    if (!owner && l && l.trusted && byId.get(l.ownerId)) { owner = byId.get(l.ownerId); how = `Learned: the Ziwo app logged ${l.count} of their calls under this user`; }
    if (!owner) {
      const k = localPart(z.username || z.email);
      const hit = k ? byLocal.get(k) : undefined;
      if (hit) { owner = hit; how = "Same name before the @"; } else if (hit === null) notes.push(`"${k}" is the start of more than one HubSpot email`);
    }
    if (!owner && name) {
      const hit = byName.get(norm(name));
      if (hit) { owner = hit; how = "Same full name"; } else if (hit === null) notes.push(`More than one HubSpot user is called ${name}`);
    }
    // worth knowing: the Ziwo app put this person's calls under somebody else
    if (owner && l && l.trusted && l.ownerId !== owner.id && how !== "Set by hand in config.js") {
      notes.push(`But the Ziwo app logged ${l.count} of their calls under ${(byId.get(l.ownerId) || {}).name || l.ownerId} - check, and fix in config.js if needed`);
    }
    result.set(z.id, owner
      ? { ownerId: owner.id, ownerName: owner.name, how, note: notes.join("; ") }
      : { ownerId: "", ownerName: "", how: "Not matched", note: notes.join("; ") || "No HubSpot user with the same email or name - add them in config.js" });
  }
  return result;
}

module.exports = { matchAgents, learn, fullName, norm, localPart };
