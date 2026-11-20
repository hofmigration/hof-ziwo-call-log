// 0-ziwo.js — reading Ziwo. Nothing in Ziwo is ever changed.
//
// Ziwo's API lives at https://<account>-api.aswat.co, where <account> is the Ziwo account
// name you type on the app.ziwo.io sign-in page — for HOF, hof-biz, so the API is
// https://hof-biz-api.aswat.co.
//
// Signing in, as Ziwo's own guide says (Ziwo → Company → Service Accounts → Help Guide): an
// app uses a SERVICE ACCOUNT. Its name and password go to POST /auth/login as JSON,
//   { "username": "<account name>", "password": "<password>" }
// and content.access_token from the answer is sent with every request, in an "access_token"
// header. ZIWO_USERNAME and ZIWO_PASSWORD hold that name and password. (What Ziwo calls a
// service account's "key" is its password.) Give it the Admin role, so every consultant's
// calls are visible and not just one person's.
const { SETTINGS } = require("./config");
const { read } = require("./2-phone");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const first = (...v) => v.find((x) => x !== undefined && x !== null && x !== "");
const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const state = { base: null, token: null, from: "", requests: 0, retries: 0 };

const ACCOUNT_HELP = "the Ziwo account name you type on the app.ziwo.io sign-in page (for HOF: hof-biz)";
function baseUrl() {
  const v = str(process.env.ZIWO_INSTANCE);
  if (!v) throw new Error(`The ZIWO_INSTANCE secret is missing. Put in ${ACCOUNT_HELP}.`);
  const m = v.match(/([a-z0-9][a-z0-9-]*?)(?:-api)?\.(?:aswat\.co|ziwo\.io)/i);
  const name = (m ? m[1] : v.replace(/^https?:\/\//i, "").replace(/[/:].*$/, "")).toLowerCase();
  // app.ziwo.io is Ziwo's sign-in page for everyone, not an account
  if (/^(app|v1|www|admin|login)$/.test(name)) throw new Error(`The ZIWO_INSTANCE secret says "${v}", which is Ziwo's sign-in page, not your account. Put in ${ACCOUNT_HELP}.`);
  return `https://${name}-api.aswat.co`;
}
// why Ziwo could not be reached, in words that say what to do
function unreachable(e) {
  const code = e && e.cause && e.cause.code;
  if (code === "ENOTFOUND") return new Error(`Could not reach Ziwo at ${state.base}: that address does not exist. Check the ZIWO_INSTANCE secret is ${ACCOUNT_HELP}.`);
  return new Error(`Could not reach Ziwo at ${state.base}: ${e.message}${code ? ` (${code})` : ""}`);
}

// what Ziwo said when it refused, if it said anything
function ziwoSays(j) {
  if (!j || typeof j !== "object") return "";
  const c = j.content && typeof j.content === "object" ? j.content : {};
  const m = [j.message, j.error, c.message, c.error, Array.isArray(j.errors) ? j.errors.map((e) => (e && e.message) || e).join("; ") : ""]
    .find((x) => typeof x === "string" && x.trim());
  return m ? m.replace(/\s+/g, " ").trim().slice(0, 160) : "";
}

const HOW_TO = "In Ziwo: menu → Company → Service Accounts → New Service Account (role Admin). Put its account name in ZIWO_USERNAME and its password in ZIWO_PASSWORD.";
const password = () => str(process.env.ZIWO_PASSWORD) || str(process.env.ZIWO_API_KEY);   // a service account's "key" is its password

async function signIn() {
  const u = str(process.env.ZIWO_USERNAME), p = password();
  if (!u || !p) return null;
  let res;
  try {
    res = await fetch(`${state.base}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ username: u, password: p }),
    });
  } catch (e) { throw unreachable(e); }
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
  const t = j && j.content && j.content.access_token;
  if (!res.ok || !t) {
    const said = ziwoSays(j);
    throw new Error(`Ziwo sign-in failed (${res.status}${said ? `: Ziwo said "${said}"` : ""}). Check ZIWO_USERNAME holds the service account's name exactly as Ziwo shows it, and ZIWO_PASSWORD its password. ${HOW_TO}`);
  }
  state.from = "sign-in";
  return t;
}

async function token() {
  if (state.token) return state.token;
  if (!state.base) state.base = baseUrl();
  // a service account's name and password: sign in, the way Ziwo's guide says
  if (str(process.env.ZIWO_USERNAME) && password()) { state.token = await signIn(); return state.token; }
  // an access token pasted in on its own
  if (str(process.env.ZIWO_API_KEY)) { state.token = str(process.env.ZIWO_API_KEY); state.from = "key"; return state.token; }
  throw new Error(`Ziwo has no way in: ZIWO_USERNAME and ZIWO_PASSWORD are not set. ${HOW_TO}`);
}

async function zget(path, params = {}, attempt = 0, renewed = false) {
  const tok = await token();
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  state.requests++;
  let res;
  try {
    res = await fetch(`${state.base}${path}${qs ? `?${qs}` : ""}`, { headers: { access_token: tok, Accept: "application/json" } });
  } catch (e) {
    // an address that does not exist will not start existing on a second try
    if (e && e.cause && e.cause.code === "ENOTFOUND") throw unreachable(e);
    if (attempt < 5) { state.retries++; await sleep(2000 * (attempt + 1)); return zget(path, params, attempt + 1, renewed); }
    throw unreachable(e);
  }
  if (res.status === 401 || res.status === 403) {
    // a token that has run out: sign in again, once
    if (!renewed && state.from === "sign-in") {
      state.token = await signIn();
      return zget(path, params, attempt, true);
    }
    const e = new Error(`Ziwo refused the request (${res.status}). ${state.from === "key"
      ? `ZIWO_API_KEY on its own is not something Ziwo accepts. ${HOW_TO}`
      : "That Ziwo account cannot read the call history - give the service account the Admin role."}`);
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

module.exports = { agents, calls, callOf, agentOf, baseUrl, token, state, NUMBER_FIELDS };
