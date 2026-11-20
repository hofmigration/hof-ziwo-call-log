// 1-hubspot.js — HubSpot. Calls, contacts, deals and users are read. The only thing ever
// written is a missing call, and only on a live run.
//
// HubSpot allows five searches a second for the whole account (the other agents share
// that), so searches are paced, and a busy moment is simply waited out.
const { SETTINGS } = require("./config");
const { searchForms } = require("./2-phone");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function throttle(rps) {
  let next = 0;
  return async () => { const now = Date.now(); const at = Math.max(now, next); next = at + 1000 / rps; if (at > now) await sleep(at - now); };
}
const api = throttle(SETTINGS.API_RPS);
const gate = { search: throttle(SETTINGS.SEARCH_RPS), api, write: api };
const stats = { calls: 0, retries: 0 };

// The Ziwo call id, as the Ziwo app (and this agent) write it on the first line of a call:
// "Call id : ee4d3de6-6991-446f-9200-3d12f7aafc27"
const ZIWO_ID = /call\s*id\s*:?\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{6,})/i;

// kind "write" is never repeated after a dropped connection or a HubSpot error, because
// HubSpot may already have saved it and a repeat would log the call twice. Only "too many
// requests" (which HubSpot never saves) is waited out and repeated.
async function hs(method, path, body, kind = "api", attempt = 0) {
  await gate[kind]();
  stats.calls++;
  let res;
  try {
    res = await fetch(`https://api.hubapi.com${path}`, {
      method, headers: { Authorization: `Bearer ${process.env.HUBSPOT_TOKEN}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (kind !== "write" && attempt < 6) { stats.retries++; await sleep(2000 * (attempt + 1)); return hs(method, path, body, kind, attempt + 1); }
    throw new Error(`Could not reach HubSpot: ${e.message}`);
  }
  if ((res.status === 429 || (res.status >= 500 && kind !== "write")) && attempt < 8) {
    stats.retries++;
    await sleep(Math.min(30000, 1500 * 2 ** attempt));
    return hs(method, path, body, kind, attempt + 1);
  }
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
    e.status = res.status;
    if (/MISSING_SCOPES/i.test(text)) e.message = `HubSpot token is missing a permission: ${text.slice(0, 300)}`;
    throw e;
  }
  return text ? JSON.parse(text) : null;
}

// ---------------------------------------------------------------- searching
// Every record matching `filters` with hs_timestamp in [from, to). HubSpot will not page
// past 10,000 results in one search, so a window holding more is halved until each part
// fits — nothing is silently cut short.
async function searchAll(obj, filters, properties, from, to, depth = 0) {
  const group = (f, t) => [{ filters: [...filters,
    { propertyName: "hs_timestamp", operator: "GTE", value: String(f) },
    { propertyName: "hs_timestamp", operator: "LT", value: String(t) }] }];
  const probe = await hs("POST", `/crm/v3/objects/${obj}/search`, { filterGroups: group(from, to), properties: ["hs_timestamp"], limit: 1 }, "search");
  const total = (probe && probe.total) || 0;
  if (!total) return [];
  if (total > 9800 && depth < 16 && to - from > 60e3) {
    const mid = Math.floor((from + to) / 2);
    return [...(await searchAll(obj, filters, properties, from, mid, depth + 1)), ...(await searchAll(obj, filters, properties, mid, to, depth + 1))];
  }
  const out = []; let after;
  for (let i = 0; i < 120; i++) {
    const r = await hs("POST", `/crm/v3/objects/${obj}/search`, {
      filterGroups: group(from, to), sorts: [{ propertyName: "hs_timestamp", direction: "ASCENDING" }], properties, limit: 100, after,
    }, "search");
    out.push(...((r && r.results) || []));
    after = r && r.paging && r.paging.next && r.paging.next.after;
    if (!after) break;
  }
  if (out.length < total) console.log(`  !! HubSpot said ${total} ${obj} in a window but ${out.length} were read`);
  return out;
}

// all pages of a search that is not about dates
async function searchPaged(obj, filterGroups, properties) {
  const out = []; let after;
  for (let i = 0; i < 50; i++) {                  // 50 pages x 200 = HubSpot's 10,000 limit
    const r = await hs("POST", `/crm/v3/objects/${obj}/search`, { filterGroups, properties, limit: 200, after }, "search");
    out.push(...((r && r.results) || []));
    after = r && r.paging && r.paging.next && r.paging.next.after;
    if (!after) break;
  }
  return out;
}

// ---------------------------------------------------------------- associations and reads
// HubSpot's batch size for associations has changed over time, so it starts big and halves
// on refusal rather than assuming.
let assocBatch = 1000;
async function links(fromObj, toObj, ids) {
  const map = new Map();
  const list = [...new Set(ids.map(String))];
  for (let i = 0; i < list.length;) {
    const chunk = list.slice(i, i + assocBatch);
    try {
      const r = await hs("POST", `/crm/v4/associations/${fromObj}/${toObj}/batch/read`, { inputs: chunk.map((id) => ({ id })) });
      for (const row of (r && r.results) || []) map.set(String(row.from && row.from.id), [...new Set((row.to || []).map((t) => String(t.toObjectId)))]);
      i += chunk.length;
    } catch (e) {
      if (e.status === 400 && assocBatch > 100) { assocBatch = Math.max(100, Math.floor(assocBatch / 2)); continue; }
      throw e;
    }
  }
  return map;
}

async function batchRead(obj, ids, properties) {
  const map = new Map();
  const list = [...new Set(ids.map(String))];
  for (let i = 0; i < list.length; i += 100) {
    const r = await hs("POST", `/crm/v3/objects/${obj}/batch/read`, { properties, inputs: list.slice(i, i + 100).map((id) => ({ id })) });
    for (const o of (r && r.results) || []) map.set(String(o.id), o.properties || {});
  }
  return map;
}

// ---------------------------------------------------------------- calls already in HubSpot
const CALL_PROPS = ["hs_timestamp", "hs_call_body", "hs_call_title", "hubspot_owner_id", "hs_call_to_number", "hs_call_from_number",
  "hs_call_disposition", "hs_call_direction", "hs_call_source", "hs_call_status"];

async function callsBetween(from, to) {
  const rows = await searchAll("calls", [], CALL_PROPS, from, to);
  const calls = rows.map((r) => {
    const p = r.properties || {};
    return { id: String(r.id), at: Date.parse(p.hs_timestamp) || 0, body: String(p.hs_call_body || ""), title: String(p.hs_call_title || ""),
      owner: String(p.hubspot_owner_id || ""), to: String(p.hs_call_to_number || ""), from: String(p.hs_call_from_number || ""),
      disposition: String(p.hs_call_disposition || ""), direction: String(p.hs_call_direction || ""), source: String(p.hs_call_source || "") };
  });
  const ids = calls.map((c) => c.id);
  const [toContacts, toDeals] = [await links("calls", "contacts", ids), await links("calls", "deals", ids)];
  for (const c of calls) { c.contacts = toContacts.get(c.id) || []; c.deals = toDeals.get(c.id) || []; }
  return calls;
}

// ---------------------------------------------------------------- contacts by number
const CONTACT_PROPS = ["firstname", "lastname", "email", "phone", "mobilephone", "mobile_number", "hs_whatsapp_phone_number",
  "hubspot_owner_id", "notes_last_contacted", "lastmodifieddate"];

// Every contact that might hold one of these numbers. HubSpot's search also returns numbers
// that only START the same way, so every result is checked digit by digit afterwards
// (2-phone.js) — a search hit alone is never trusted.
async function contactsByNumbers(e164s) {
  const nsn = new Set(), full = new Set();
  for (const e of e164s) { const f = searchForms(e); f.nsn.forEach((x) => nsn.add(x)); f.full.forEach((x) => full.add(x)); }
  const found = new Map(), notes = [];
  async function ask(prop, values) {
    const list = [...values];
    for (let i = 0; i < list.length; i += 500) {
      const chunk = list.slice(i, i + 500), filterGroups = [];
      for (let k = 0; k < chunk.length; k += 100) filterGroups.push({ filters: [{ propertyName: prop, operator: "IN", values: chunk.slice(k, k + 100) }] });
      try {
        for (const c of await searchPaged("contacts", filterGroups, CONTACT_PROPS)) found.set(String(c.id), c.properties || {});
      } catch (e) {
        if (e.status === 400) { notes.push(`HubSpot would not search by ${prop}: ${e.message.slice(0, 160)}`); return; }
        throw e;
      }
    }
  }
  await ask("hs_searchable_calculated_phone_number", nsn);   // +971..., 050..., 50... in Phone number
  await ask("hs_searchable_calculated_mobile_number", nsn);  // the same in Mobile phone number
  await ask("hs_searchable_calculated_phone_number", full);  // 00971... and some 971... (no plus)
  await ask("hs_searchable_calculated_mobile_number", full);
  await ask("phone", full);                                  // 971501234567 typed with no plus
  await ask("mobilephone", full);
  // "Mobile number" and "WhatsApp phone number" cannot be searched by number, so every
  // contact that has one is read (about a thousand).
  for (const prop of ["mobile_number", "hs_whatsapp_phone_number"]) {
    const rows = await searchPaged("contacts", [{ filters: [{ propertyName: prop, operator: "HAS_PROPERTY" }] }], CONTACT_PROPS);
    for (const c of rows) found.set(String(c.id), c.properties || {});
    if (rows.length >= 10000) notes.push(`More than 10,000 contacts have ${prop}; only the first 10,000 were read.`);
  }
  return { contacts: found, notes };
}

// ---------------------------------------------------------------- deals
async function dealsOf(contactIds) {
  const byContact = await links("contacts", "deals", contactIds);
  const dealIds = [...new Set([...byContact.values()].flat())];
  const deals = await batchRead("deals", dealIds, ["dealname", "hs_is_closed", "pipeline", "dealstage", "hubspot_owner_id"]);
  return { byContact, deals };
}

// ---------------------------------------------------------------- users and outcomes
async function owners() {
  const list = []; let after;
  for (let i = 0; i < 20; i++) {
    const r = await hs("GET", `/crm/v3/owners?limit=500${after ? `&after=${encodeURIComponent(after)}` : ""}`);
    for (const o of (r && r.results) || []) {
      if (o.archived) continue;
      list.push({ id: String(o.id), email: String(o.email || "").toLowerCase(), firstName: String(o.firstName || "").trim(),
        lastName: String(o.lastName || "").trim(), name: `${o.firstName || ""} ${o.lastName || ""}`.trim() || String(o.email || o.id) });
    }
    after = r && r.paging && r.paging.next && r.paging.next.after;
    if (!after) break;
  }
  return list;
}

// HubSpot's call outcomes, by name. The ids in config.js are the fallback.
async function dispositions() {
  const byId = {}, byLabel = {};
  try {
    const r = await hs("GET", "/calling/v1/dispositions");
    for (const d of Array.isArray(r) ? r : []) { byId[String(d.id)] = d.label; byLabel[String(d.label).toLowerCase()] = String(d.id); }
  } catch { /* the fallback ids are used */ }
  return { byId, byLabel };
}

// What the HubSpot token is allowed to do, so a dry run can say whether a live run will be
// able to log calls. null when HubSpot will not say.
async function tokenScopes() {
  try {
    const r = await hs("POST", "/oauth/v2/private-apps/get/access-token-info", { tokenKey: process.env.HUBSPOT_TOKEN });
    return Array.isArray(r && r.scopes) ? r.scopes : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- the one write
const ASSOCIATION = { contact: 194, deal: 206 };   // HubSpot's own "call to contact" and "call to deal"

function inputOf(item) {
  const associations = [
    ...(item.contactId ? [{ to: { id: String(item.contactId) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOCIATION.contact }] }] : []),
    ...(item.dealIds || []).map((d) => ({ to: { id: String(d) }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOCIATION.deal }] })),
  ];
  return { properties: item.properties, associations, objectWriteTraceId: item.key };
}

// items: [{ key, properties, contactId, dealIds }] -> Map key -> { id } or { error }.
// The key is the Ziwo call id, which is also on the call's first line, so every saved call
// can be told apart even if HubSpot answers in a different order.
const keyOf = (x) => String(x.objectWriteTraceId || (String((x.properties || {}).hs_call_body || "").match(ZIWO_ID) || [])[1] || "");
const fatal = (e) => e.status === 401 || e.status === 403 || /permission|MISSING_SCOPES/i.test(e.message);
const UNCONFIRMED = "HubSpot did not confirm this one. Run the agent again for this date: calls already saved are recognised and never logged twice.";

async function createCalls(items) {
  const out = new Map();
  for (let i = 0; i < items.length; i += 100) {
    const chunk = items.slice(i, i + 100);
    let r = null;
    try {
      r = await hs("POST", "/crm/v3/objects/calls/batch/create", { inputs: chunk.map(inputOf) }, "write");
    } catch (e) {
      if (fatal(e)) throw e;
      if (!e.status || e.status >= 500) { chunk.forEach((it) => out.set(it.key, { error: UNCONFIRMED })); continue; }
      r = null;                                   // the whole batch was refused: try them one at a time
    }
    for (const x of (r && r.results) || []) { const k = keyOf(x); if (k) out.set(k, { id: String(x.id) }); }
    for (const item of chunk) {
      if (out.has(item.key)) continue;
      if (r && !(r.errors && r.errors.length)) { out.set(item.key, { error: UNCONFIRMED }); continue; }
      try {
        const one = await hs("POST", "/crm/v3/objects/calls", inputOf(item), "write");
        out.set(item.key, { id: String(one.id) });
      } catch (e) {
        if (fatal(e)) throw e;
        out.set(item.key, { error: !e.status || e.status >= 500 ? UNCONFIRMED : e.message.slice(0, 200) });
      }
    }
  }
  return out;
}

const contactLink = (id) => `https://app.hubspot.com/contacts/${SETTINGS.PORTAL_ID}/record/0-1/${id}`;
const callLink = (id) => `https://app.hubspot.com/calls/${SETTINGS.PORTAL_ID}/review/${id}`;

module.exports = { hs, tokenScopes, callsBetween, contactsByNumbers, dealsOf, owners, dispositions, createCalls, contactLink, callLink, stats, CONTACT_PROPS, ZIWO_ID };
