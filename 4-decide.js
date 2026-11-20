// 4-decide.js — for every Ziwo call: is it already in HubSpot, and if not, how is it logged?
//
// Pure logic, no API calls, so every rule can be tested (selftest.js).
const { SETTINGS: S } = require("./config");
const { read, pretty, contactsFor } = require("./2-phone");
const { ZIWO_ID } = require("./1-hubspot");
const { fullName } = require("./3-people");

const MARKER = "Logged automatically from Ziwo by the call-log agent";
const TZ = () => S.TZ_OFFSET_HOURS * 3600e3;
const hhmm = (ms) => new Date(ms + TZ()).toISOString().slice(11, 16);
const dayOf = (ms) => new Date(ms + TZ()).toISOString().slice(0, 10);
const mmss = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.round(s || 0) % 60).padStart(2, "0")}`;

// ---------------------------------------------------------------- the outcome
//   Connected  answered, and talked for CONNECTED_MIN_TALK_SECONDS or more
//   Busy       Ziwo says busy, or the client rejected the call
//   No answer  everything else
function outcomeOf(c) {
  if (c.answered && c.talk >= S.CONNECTED_MIN_TALK_SECONDS) return "Connected";
  if (S.BUSY_RESULTS.includes(c.result) || S.BUSY_HANGUP_CAUSES.includes(c.hangupCause)) return "Busy";
  return "No answer";
}

// ---------------------------------------------------------------- calls already in HubSpot
// Map Ziwo call id -> the HubSpot calls that carry it. `ours` marks calls this agent logged.
function byZiwoId(hubspotCalls) {
  const m = new Map();
  for (const h of hubspotCalls) {
    const id = (h.body.match(ZIWO_ID) || [])[1];
    h.ziwoId = id ? id.toLowerCase() : "";
    h.ours = h.body.includes(MARKER);
    if (!h.ziwoId) continue;
    if (!m.has(h.ziwoId)) m.set(h.ziwoId, []);
    m.get(h.ziwoId).push(h);
  }
  return m;
}

// HubSpot calls that are NOT tied to a Ziwo call id (logged by people), indexed by the
// client's contact, deal and number. A call with a Ziwo call id only ever stands for its
// own Ziwo call, so it is left out here.
function indexManual(hubspotCalls) {
  const byContact = new Map(), byDeal = new Map(), byNumber = new Map();
  const add = (m, k, h) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(h); };
  for (const h of hubspotCalls) {
    if (h.ziwoId) continue;
    h.contacts.forEach((id) => add(byContact, String(id), h));
    h.deals.forEach((id) => add(byDeal, String(id), h));
    for (const n of [h.to, h.from]) { const r = read(n); if (r && r.e164) add(byNumber, r.e164, h); }
  }
  return { byContact, byDeal, byNumber };
}

// THE RULE: a call people logged on this client from 1 minute before the Ziwo call started
// to 30 minutes after it. Returns the earliest such call, or null.
function coveringCall(start, contactIds, dealIds, e164, manual) {
  const lo = start - S.WINDOW_BEFORE_MINUTES * 60e3, hi = start + S.WINDOW_AFTER_MINUTES * 60e3;
  const seen = new Map();
  const look = (list, where) => (list || []).forEach((h) => { if (h.at >= lo && h.at <= hi && !seen.has(h.id)) seen.set(h.id, { ...h, where }); });
  contactIds.forEach((id) => look(manual.byContact.get(String(id)), "contact"));
  dealIds.forEach((id) => look(manual.byDeal.get(String(id)), "deal"));
  look(manual.byNumber.get(e164), "number");
  return [...seen.values()].sort((a, b) => a.at - b.at)[0] || null;
}

// ---------------------------------------------------------------- which field is the client
// The Ziwo app has already put some calls in HubSpot with the client's number on them. For
// those calls, the Ziwo field holding the same number is the client's field.
function calibrate(calls, ziwoIds) {
  const result = {};
  for (const dir of ["outbound", "inbound"]) {
    const tally = new Map(); let pairs = 0;
    for (const c of calls) {
      if (c.direction !== dir) continue;
      const h = (ziwoIds.get(c.id.toLowerCase()) || []).find((x) => !x.ours);
      if (!h) continue;
      const r = read(dir === "inbound" ? h.from : h.to);
      if (!r || !r.e164) continue;
      pairs++;
      for (const f of new Set(c.numbers.filter((n) => n.e164 === r.e164).map((n) => n.field))) tally.set(f, (tally.get(f) || 0) + 1);
    }
    const best = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    result[dir] = best && best[1] >= 3 && best[1] / pairs >= 0.6
      ? { field: best[0], matched: best[1], pairs }
      : { field: "", matched: best ? best[1] : 0, pairs };
  }
  return result;
}

// HOF's own lines: config.js, the number clients dialled on incoming calls, and any number
// on dozens of calls from three or more consultants in a day.
function hofNumbers(calls) {
  const set = new Map();
  for (const n of S.HOF_NUMBERS) { const r = read(n); if (r && r.e164) set.set(r.e164, "config.js"); }
  const count = new Map(), people = new Map();
  for (const c of calls) {
    for (const e of new Set(c.numbers.map((n) => n.e164))) {
      count.set(e, (count.get(e) || 0) + 1);
      if (!people.has(e)) people.set(e, new Set());
      if (c.agentId) people.get(e).add(c.agentId);
    }
    if (c.direction === "inbound") c.numbers.filter((n) => n.field === "didCalled").forEach((n) => { if (!set.has(n.e164)) set.set(n.e164, "dialled by clients calling in"); });
  }
  const many = Math.max(25, Math.ceil(calls.length * 0.02));
  for (const [e, n] of count) if (n >= many && people.get(e).size >= 3 && !set.has(e)) set.set(e, `on ${n} calls from ${people.get(e).size} consultants`);
  return set;
}

const PREFERENCE = {
  outbound: ["targetNumber", "didCalled", "contactNumber", "calledNumber", "destinationNumber", "destination", "to", "callerIDNumber"],
  inbound: ["callerIDNumber", "contactNumber", "callerNumber", "from"],
};
function clientNumberOf(c, cal, hof) {
  const outside = c.numbers.filter((n) => !hof.has(n.e164));
  if (S.CLIENT_NUMBER_FIELD && S.CLIENT_NUMBER_FIELD !== "auto") return outside.find((n) => n.field === S.CLIENT_NUMBER_FIELD) || null;
  const learned = cal[c.direction] && cal[c.direction].field;
  if (learned) { const n = outside.find((x) => x.field === learned); if (n) return n; }
  for (const f of PREFERENCE[c.direction] || []) { const n = outside.find((x) => x.field === f); if (n) return n; }
  return null;
}

// ---------------------------------------------------------------- which contact
// The same number can be on several contacts. The call goes on the one owned by the
// consultant who made it; if none is theirs, on the one worked on most recently. Between
// two otherwise equal contacts, the number saved with its country code wins.
function pickContact(matches, ownerId, contacts) {
  const recent = (id) => Date.parse((contacts.get(id) || {}).notes_last_contacted || (contacts.get(id) || {}).lastmodifieddate || "") || 0;
  const rank = (m) => [(contacts.get(m.id) || {}).hubspot_owner_id === ownerId ? 0 : 1, -recent(m.id), m.how === "Same number" ? 0 : 1];
  return [...matches].sort((a, b) => { const x = rank(a), y = rank(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; })[0];
}

const contactName = (p, fallback) => `${(p && p.firstname) || ""} ${(p && p.lastname) || ""}`.replace(/\s+/g, " ").trim() || (p && p.email) || fallback;

// ---------------------------------------------------------------- one decision per call
// ctx: { calls, hubspotCalls, people, index, contacts, dealsByContact, deals, dispositions, cal, hof, agentsById }
function decide(ctx) {
  const ziwoIds = ctx.ziwoIds || byZiwoId(ctx.hubspotCalls);
  const manual = indexManual(ctx.hubspotCalls);
  const rows = [];
  for (const c of ctx.calls) {
    const z = ctx.agentsById.get(c.agentId) || c.agent || null;
    const who = ctx.people.get(c.agentId) || null;
    const row = {
      call: c, when: c.start, consultant: z ? fullName(z) || z.username || `Ziwo user ${c.agentId}` : (c.agentId ? `Ziwo user ${c.agentId}` : ""),
      owner: who && who.ownerId ? who.ownerName : "", ownerId: who ? who.ownerId : "", outcome: outcomeOf(c),
      number: "", numberField: "", matches: [], contactId: "", contactName: "", how: "", dealIds: [],
      status: "", detail: "", input: null,
    };
    rows.push(row);
    const skip = (status, detail = "") => { row.status = status; row.detail = detail; };

    if (c.direction !== "outbound" && c.direction !== "inbound") { skip("Skipped", `Internal call (${c.direction})`); continue; }
    const num = clientNumberOf(c, ctx.cal, ctx.hof);
    if (num) { row.number = num.e164; row.numberField = num.field; }
    if (c.direction === "outbound" && !S.LOG_OUTBOUND) { skip("Skipped", "Outgoing calls are switched off in config.js"); continue; }
    if (c.direction === "inbound" && S.LOG_INBOUND === "none") { skip("Skipped", "Incoming calls are switched off in config.js"); continue; }
    if (c.direction === "inbound" && !c.answered) { skip("Skipped", "Missed incoming call"); continue; }

    // 1. the same Ziwo call is already in HubSpot
    const same = ziwoIds.get(c.id.toLowerCase());
    if (same && same.length) {
      const h = same[0];
      skip("Already in HubSpot", h.ours ? "Logged by this agent on an earlier run" : "Logged by the Ziwo app (same Ziwo call id)");
      row.hubspotCallId = h.id;
      continue;
    }
    if (!c.agentId) { skip("Not logged", "No consultant on this call in Ziwo"); continue; }
    if (who && who.skip) { skip("Skipped", "This Ziwo user is skipped in config.js"); continue; }

    // 2. the client
    if (!num) { skip("Not logged", "Ziwo has no client number on this call"); continue; }
    row.matches = contactsFor(num.e164, ctx.index);
    const contactIds = row.matches.map((m) => m.id);
    const allDeals = [...new Set(contactIds.flatMap((id) => ctx.dealsByContact.get(id) || []))];

    // 3. THE RULE: a call people logged on this client within the window
    const cover = coveringCall(c.start, contactIds, allDeals, num.e164, manual);
    if (cover) {
      const by = cover.owner ? (ctx.ownerNames.get(cover.owner) || `user ${cover.owner}`) : "someone";
      const where = cover.where === "deal" ? "on their deal" : cover.where === "number" ? "to their number" : "on their contact";
      skip("Already in HubSpot", `${by} logged a call ${where} at ${hhmm(cover.at)}`);
      row.hubspotCallId = cover.id;
      continue;
    }
    if (!row.matches.length) { skip("Not logged", "Number not in HubSpot"); continue; }
    if (!who || !who.ownerId) { skip("Not logged", `Consultant not matched to a HubSpot user (${row.consultant})`); continue; }

    // 4. log it
    const chosen = pickContact(row.matches, who.ownerId, ctx.contacts);
    const p = ctx.contacts.get(chosen.id) || {};
    row.contactId = chosen.id; row.how = chosen.how; row.contactName = contactName(p, pretty(num.e164));
    row.dealIds = S.ASSOCIATE_OPEN_DEALS
      ? (ctx.dealsByContact.get(chosen.id) || []).filter((d) => String((ctx.deals.get(d) || {}).hs_is_closed) !== "true")
      : [];
    const hofLine = c.numbers.find((n) => ctx.hof.has(n.e164));
    const properties = {
      hs_timestamp: new Date(c.start).toISOString(),
      hs_call_title: `Call with ${row.contactName}`,
      hs_call_body: `<p>Call id : ${c.id}</p><p>${MARKER} - it was not logged in HubSpot. Talk time ${mmss(c.talk)}${c.result ? `, Ziwo result: ${c.result}` : ""}.</p>`,
      hs_call_direction: c.direction === "inbound" ? "INBOUND" : "OUTBOUND",
      hs_call_disposition: ctx.dispositions[row.outcome],
      hs_call_status: row.outcome === "Connected" ? "COMPLETED" : row.outcome === "Busy" ? "BUSY" : "NO_ANSWER",
      hs_call_duration: String(Math.round(c.talk * 1000)),
      hubspot_owner_id: who.ownerId,
    };
    if (c.direction === "inbound") { properties.hs_call_from_number = num.e164; if (hofLine) properties.hs_call_to_number = hofLine.e164; }
    else { properties.hs_call_to_number = num.e164; if (hofLine) properties.hs_call_from_number = hofLine.e164; }
    row.input = { key: c.id, properties, contactId: chosen.id, dealIds: row.dealIds };
    skip("To log", row.matches.length > 1 ? `Number is on ${row.matches.length} contacts; logged on the one ${p.hubspot_owner_id === who.ownerId ? "this consultant owns" : "worked on most recently"}` : "");
  }
  return rows;
}

// pairs of (Ziwo call, the same call logged by the Ziwo app) — used to learn and to check
function appPairs(calls, ziwoIds) {
  const out = [];
  for (const c of calls) {
    const h = (ziwoIds.get(c.id.toLowerCase()) || []).find((x) => !x.ours);
    if (h) out.push({ call: c, hub: h, agentId: c.agentId, ownerId: h.owner });
  }
  return out;
}

module.exports = { decide, outcomeOf, byZiwoId, indexManual, coveringCall, calibrate, hofNumbers, clientNumberOf, pickContact, appPairs, MARKER, hhmm, dayOf, mmss };
