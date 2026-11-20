// 2-phone.js — phone numbers: reading them however they were typed, and deciding when a
// number in HubSpot is the client's number.
//
// Ziwo and HubSpot write numbers many ways: +971 50 123 4567, 971501234567, 00971501234567,
// 0501234567, 501234567, "+966… / +92…" (two in one box), "+966… ext 923…". Everything is
// turned into the international form (+971501234567) before two numbers are compared.
const { parsePhoneNumberFromString } = require("libphonenumber-js/max");
const { SETTINGS } = require("./config");

const EXT = /\s*(?:ext\.?|extension|x)\s*\d+\s*$/i;
const SPLIT = /\s*(?:\/|,|;|\||\n|\bor\b|\band\b)\s*/i;
const digitsOf = (s) => String(s ?? "").replace(/\D/g, "");

function tryParse(text, country) {
  try { return parsePhoneNumberFromString(text, country) || null; } catch { return null; }
}

// local = written with no country code, so the same digits could be any country's number
function pack(p, digits, forcedInternational) {
  const cc = p.countryCallingCode, nsn = p.nationalNumber;
  const hadCode = forcedInternational || digits === cc + nsn || digits === cc + "0" + nsn;
  return { e164: p.number, nsn, cc, local: !hadCode, valid: p.isValid() };
}

// One number -> { e164, nsn, cc, local, valid }, or null when it is not a phone number.
function read(raw, country = SETTINGS.DEFAULT_COUNTRY) {
  const s = String(raw ?? "").trim().replace(EXT, "");
  let d = digitsOf(s);
  if (d.length < 6) return null;
  if (/^\+/.test(s) || d.startsWith("00")) {                 // written with a country code
    if (!/^\+/.test(s)) d = d.slice(2);
    const p = tryParse("+" + d);
    return p && p.isPossible() ? pack(p, d, true) : null;
  }
  const loc = tryParse(d, country);                           // as a local number
  const intl = d.length >= 10 ? tryParse("+" + d) : null;     // as a country code typed without "+"
  // 11+ digits with no leading 0 is too long to be a local number: read it as international
  const longForLocal = d.length >= 11 && !d.startsWith("0");
  const possible = (p) => p && p.isPossible() && p;
  const pick =
    (d.startsWith("0") && possible(loc)) ||
    (loc && loc.isValid() && loc) ||
    (intl && intl.isValid() && intl) ||
    (longForLocal ? possible(intl) || possible(loc) : possible(loc) || possible(intl)) || null;
  if (pick) return pack(pick, d, false);
  // readable in no country: keep the local digits, so "saved without country code" can still match
  return { e164: null, nsn: d.replace(/^0+/, ""), cc: null, local: true, valid: false };
}

// Everything in one HubSpot box: "+971503035236 , +971507148071" is two numbers.
function readAll(raw) {
  return String(raw ?? "").split(SPLIT).map((part) => read(part)).filter(Boolean);
}

// "+971 50 123 4567" for people to read
function pretty(e164) {
  const p = tryParse(String(e164 || ""));
  return p ? p.formatInternational() : String(e164 || "");
}

// Last digits only, for logs (the GitHub log is not the place for client numbers).
const masked = (e164) => (e164 ? `${String(e164).slice(0, 4)}•••${String(e164).slice(-3)}` : "");

// The numbers HubSpot's search should be asked for, for one client number. HubSpot keeps
// a hidden "number without country code" field that it searches by; numbers saved with no
// "+" (971…, 00971…) only show up there under all their digits, so both are asked for.
function searchForms(e164) {
  const r = read(e164);
  if (!r || !r.e164) return { nsn: [], full: [] };
  return { nsn: [r.nsn], full: [r.cc + r.nsn] };
}

// An index of every number on a set of HubSpot contacts:
//   withCode  "+971501234567" -> contact ids (saved with a country code)
//   local     "501234567"     -> contact ids (saved with no country code)
const FIELDS = ["phone", "mobilephone", "mobile_number", "hs_whatsapp_phone_number"];
function indexContacts(contacts) {
  const withCode = new Map(), local = new Map();
  const add = (map, k, v) => { if (!k) return; if (!map.has(k)) map.set(k, new Map()); if (!map.get(k).has(v.id)) map.get(k).set(v.id, v); };
  for (const [id, props] of contacts) {
    for (const field of FIELDS) {
      for (const r of readAll(props[field])) {
        const hit = { id, field, saved: String(props[field]).trim() };
        if (r.local) add(local, r.nsn, hit);
        else add(withCode, r.e164, hit);
      }
    }
  }
  return { withCode, local };
}

// The contacts holding a client's number: [{ id, field, saved, how }]. The same number
// saved with its country code comes first; the same local number saved without one next.
// The same digits under a different country code are not a match, and nor are numbers
// that only start the same way.
function contactsFor(e164, index) {
  const r = read(e164);
  if (!r || !r.e164) return [];
  const out = new Map();
  for (const hit of (index.withCode.get(r.e164) || new Map()).values()) out.set(hit.id, { ...hit, how: "Same number" });
  for (const hit of (index.local.get(r.nsn) || new Map()).values()) {
    if (!out.has(hit.id)) out.set(hit.id, { ...hit, how: "Same number, saved without the country code" });
  }
  return [...out.values()];
}

module.exports = { read, readAll, pretty, masked, searchForms, indexContacts, contactsFor, digitsOf, FIELDS };
