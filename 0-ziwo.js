// 0-ziwo.js — reading Ziwo. Nothing in Ziwo is ever changed.
//
// Ziwo's API lives at https://<instance>-api.aswat.co, where <instance> is the first part
// of the address you sign in to Ziwo at (hofmigration.ziwo.io -> hofmigration). Every
// request carries an "access_token" header: ZIWO_API_KEY as given, or a token made by
// signing in with ZIWO_USERNAME and ZIWO_PASSWORD. Use an admin or supervisor account, so
// every consultant's calls are visible and not just one person's.
const { SETTINGS } = require("./config");
const { read } = require("./2-phone");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const first = (...v) => v.find((x) => x !== undefined && x !== null && x !== "");
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const state = { base: null, token: null, from: "", requests: 0, retries: 0 };

function baseUrl() {
  const v = str(process.env.ZIWO_INSTANCE);
  if (!v) throw new Error("The ZIWO_INSTANCE secret is missing. It is the first part of your Ziwo address (hofmigration.ziwo.io -> hofmigration).");
  const m = v.match(/([a-z0-9][a-z0-9-]*?)(?:-api)?\.(?:aswat\.co|ziwo\.io)/i);
  const name = m ? m[1] : v.replace(/^https?:\/\//i, "").replace(/[/:].*$/, "");
  return `https://${name.toLowerCase()}-api.aswat.co`;
}

async function signIn() {
  const u = str(process.env.ZIWO_USERNAME), p = str(process.env.ZIWO_PASSWORD);
  if (!u || !p) return null;
  const body = new URLSearchParams({ username: u, password: p, remember: "true", deviceType: "Web" });
  const res = await fetch(`${state.base}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: body.toString(),
  });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
  const t = j && j.content && j.content.access_token;
  if (!res.ok || !t) throw new Error(`Ziwo sign-in failed (${res.status}). Check the ZIWO_USERNAME and ZIWO_PASSWORD secrets.`);
  state.from = "sign-in";
  return t;
}

async function token() {
  if (state.token) return state.token;
  if (!state.base) state.base = baseUrl();
  if (str(process.env.ZIWO_API_KEY)) { state.token = str(process.env.ZIWO_API_KEY); state.from = "key"; return state.token; }
  state.token = await signIn();
  if (!state.token) throw new Error("Ziwo has no way in: add the ZIWO_API_KEY secret, or ZIWO_USERNAME and ZIWO_PASSWORD.");
  return state.token;
}

async function zget(path, params = {}, attempt = 0, renewed = false) {
  const tok = await token();
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  state.requests++;
  let res;
  try {
    res = await fetch(`${state.base}${path}${qs ? `?${qs}` : ""}`, { headers: { access_token: tok, Accept: "application/json" } });
  } catch (e) {
    if (attempt < 5) { state.retries++; await sleep(2000 * (attempt + 1)); return zget(path, params, attempt + 1, renewed); }
    throw new Error(`Could not reach Ziwo at ${state.base}: ${e.message}`);
  }
  if (res.status === 401 || res.status === 403) {
    // a key that has run out, or a token from an earlier sign-in: sign in again once
    if (!renewed && str(process.env.ZIWO_USERNAME) && str(process.env.ZIWO_PASSWORD)) {
      state.token = await signIn();
      return zget(path, params, attempt, true);
    }
    const e = new Error(`Ziwo refused the request (${res.status}). ${state.from === "key"
      ? "The ZIWO_API_KEY was not accepted - add ZIWO_USERNAME and ZIWO_PASSWORD of an admin or supervisor instead."
      : "That Ziwo account cannot read the call history - it needs to be an admin or supervisor."}`);
    e.status = res.status;
    throw e;
  }
  if ((res.status === 429 || res.status >= 500) && attempt < 6) {
    state.retries++;
    await sleep(Math.min(30000, 1500 * 2 ** attempt));
    return zget(path, params, attempt + 1, renewed);
  }
  const text = await res.text();
  if (!res.ok) { const e = new Error(`Ziwo ${path} -> ${res.status} ${text.slice(0, 200)}`); e.status = res.status; throw e; }
  try { return JSON.parse(text); } catch { throw new Error(`Ziwo ${path} did not answer in JSON`); }
}

const listOf = (j) => (Array.isArray(j && j.content) ? j.content : Array.isArray(j) ? j : []);

// ---------------------------------------------------------------- people
function agentOf(a) {
  if (!a || typeof a !== "object" || first(a.id, a.agentId) === undefined) return null;
  const username = str(first(a.username, a.userName, a.login, a.email));
  return {
    id: str(first(a.id, a.agentId)), firstName: str(a.firstName), lastName: str(a.lastName), username,
    email: str(first(a.email, /@/.test(username) ? username : "")).toLowerCase(), ccLogin: str(a.ccLogin),
  };
}

async function agents() {
  try {
    return listOf(await zget("/callHistory/listAgents", { deleted: "false" })).map(agentOf).filter(Boolean);
  } catch (e) {
    console.log(`  Ziwo's user list could not be read (${e.message.slice(0, 140)}). Users are taken from the calls instead.`);
    return [];
  }
}

// ---------------------------------------------------------------- calls
// Fields that can hold a phone number in a Ziwo call record. Which one is the client
// depends on the direction, and is checked each run (see 4-decide.js).
const NUMBER_FIELDS = ["targetNumber", "didCalled", "contactNumber", "calledNumber", "destinationNumber", "destination",
  "callerIDNumber", "callerNumber", "to", "from"];

function callOf(c) {
  const start = Date.parse(first(c.startedAt, c.createdAt, c.startTime) || "");
  const answeredAt = Date.parse(c.answeredAt || "");
  const ended = Date.parse(first(c.endedAt, c.endTime) || "");
  let talk = Number(first(c.talkTime, c.talk_time, c.billsec));
  if (!Number.isFinite(talk)) talk = Number.isFinite(answeredAt) && Number.isFinite(ended) ? Math.max(0, (ended - answeredAt) / 1000) : 0;
  const dir = str(first(c.direction, c.callDirection)).toLowerCase();
  const direction = dir.startsWith("out") ? "outbound" : dir.startsWith("in") && !dir.startsWith("internal") ? "inbound" : dir || "unknown";
  const agent = agentOf(c.agent);
  const agentId = str(first(c.agentId, c.agentID, c.agent_id, agent && agent.id, c.userId, c.user && c.user.id));
  const numbers = [];
  for (const field of NUMBER_FIELDS) {
    const v = c[field];
    if (v === undefined || v === null || v === "" || typeof v === "object") continue;
    const r = read(v);
    if (r && r.e164 && r.nsn.length >= 6) numbers.push({ field, e164: r.e164, raw: str(v) });
  }
  return {
    id: str(first(c.callID, c.callId, c.uuid, c.id)), start, talk: Math.round(talk), ring: Math.round(Number(c.ringTime) || 0),
    answered: talk > 0 || Number.isFinite(answeredAt), direction,
    result: str(first(c.result, c.status, c.callResult)).toLowerCase(), hangupCause: str(c.hangupCause).toUpperCase(),
    agentId, agent, numbers, fields: Object.keys(c),
  };
}

// one record per call: a transferred call can come back as several parts
function better(a, b) {
  if (Boolean(a.agentId) !== Boolean(b.agentId)) return Boolean(a.agentId);
  return a.talk > b.talk;
}

// Every call that started in [fromMs, toMs). Ziwo is asked for a day either side as well
// (its dates may be in another time zone) and the exact range is cut here.
async function calls(fromMs, toMs) {
  const tz = SETTINGS.TZ_OFFSET_HOURS * 3600e3, day = 864e5;
  const ymd = (ms) => new Date(ms + tz).toISOString().slice(0, 10);
  const dates = { fromDate: ymd(fromMs - day), toDate: ymd(toMs + day) };
  const size = SETTINGS.ZIWO_PAGE_SIZE;
  const rows = [];
  let skip = 0, pages = 0, dated = true, cappedOut = false, lastFirst = null;
  for (;;) {
    let j;
    try {
      j = await zget("/callHistory/", { ...(dated ? dates : {}), limit: size, skip });
    } catch (e) {
      if (dated && skip === 0 && e.status === 400) { dated = false; continue; }   // dates not accepted: read without
      throw e;
    }
    const page = listOf(j);
    if (!page.length) break;
    const firstKey = str(first(page[0].callID, page[0].id));
    if (firstKey && firstKey === lastFirst) throw new Error("Ziwo sent the same page twice - its paging is not working, so the run stopped rather than miss calls.");
    lastFirst = firstKey;
    rows.push(...page);
    pages++;
    skip += page.length;
    const times = page.map((c) => Date.parse(c.startedAt || c.createdAt || "")).filter(Number.isFinite);
    if (times.length && Math.max(...times) < fromMs - day) break;                 // newest first, and already past the start
    if (pages >= SETTINGS.ZIWO_MAX_PAGES) { cappedOut = true; break; }
  }
  const byId = new Map();
  for (const c of rows.map(callOf)) {
    if (!c.id || !Number.isFinite(c.start) || c.start < fromMs || c.start >= toMs) continue;
    const prev = byId.get(c.id);
    if (!prev || better(c, prev)) byId.set(c.id, c);
  }
  return { calls: [...byId.values()].sort((a, b) => a.start - b.start), read: rows.length, pages, dated, cappedOut };
}

module.exports = { agents, calls, callOf, agentOf, baseUrl, state, NUMBER_FIELDS };
