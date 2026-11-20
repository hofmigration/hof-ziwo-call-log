// run.js — the daily run: read Ziwo, check HubSpot, log what is missing (live runs only),
// then email the result with the full sheet attached.
//
//   MODE       "live" or "dry-run" (blank = SCHEDULED_MODE in config.js)
//   FROM_DATE  first day to check, e.g. 2026-11-17 (blank = yesterday, Dubai time)
//   TO_DATE    last day to check (blank = the same as FROM_DATE)
const fs = require("fs");
const path = require("path");
const { SETTINGS: S } = require("./config");
const Z = require("./0-ziwo");
const H = require("./1-hubspot");
const { indexContacts, contactsFor, pretty } = require("./2-phone");
const { matchAgents, learn, fullName } = require("./3-people");
const D = require("./4-decide");
const { build } = require("./5-workbook");
const { buildEmail, sendEmail } = require("./6-email");

const TZ = S.TZ_OFFSET_HOURS * 3600e3, DAY = 864e5;
const startOf = (ymd) => Date.parse(`${ymd}T00:00:00Z`) - TZ;
const n = (x) => Number(x || 0).toLocaleString("en-US");
const label = (ymd) => {           // "Tue 17 Nov 2026"
  const d = new Date(`${ymd}T12:00:00Z`);
  return `${"Sun Mon Tue Wed Thu Fri Sat".split(" ")[d.getUTCDay()]} ${d.getUTCDate()} ${"Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ")[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

function range(now = Date.now()) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const f = String(process.env.FROM_DATE || "").trim(), t = String(process.env.TO_DATE || "").trim();
  let fromYmd, toYmd;
  if (f) {
    if (!re.test(f)) throw new Error(`FROM_DATE "${f}" is not a date like 2026-11-17`);
    if (t && !re.test(t)) throw new Error(`TO_DATE "${t}" is not a date like 2026-11-17`);
    fromYmd = f; toYmd = t || f;
  } else {
    fromYmd = toYmd = D.dayOf(startOf(D.dayOf(now)) - DAY);
  }
  if (toYmd < fromYmd) [fromYmd, toYmd] = [toYmd, fromYmd];
  const from = startOf(fromYmd), end = startOf(toYmd) + DAY;
  const days = Math.round((end - from) / DAY);
  if (days > S.MAX_DAYS_PER_RUN) throw new Error(`At most ${S.MAX_DAYS_PER_RUN} days in one run - split the dates into smaller runs.`);
  // calls from the last 30 minutes are left alone: the consultant may still be logging them
  const to = Math.min(end, now - S.WINDOW_AFTER_MINUTES * 60e3);
  if (to <= from) throw new Error("Those dates have not finished yet.");
  return { from, to, fromYmd, toYmd, days, cut: to < end };
}

function modeOf() {
  const m = String(process.env.MODE || "").toLowerCase();
  if (m.includes("live")) return "live";
  if (m.includes("dry")) return "dry-run";
  return String(S.SCHEDULED_MODE).toLowerCase().includes("live") ? "live" : "dry-run";
}

const RULES = () => [
  "What it does",
  "Every morning it reads the day before's calls from Ziwo (Dubai time, midnight to midnight) and checks each one against HubSpot. Calls that are already there are left alone. Calls that are missing are logged.",
  "Is the call already in HubSpot?",
  "1. A HubSpot call with the same Ziwo call id is the same call. Calls the Ziwo app puts in HubSpot start with \"Call id : <Ziwo call id>\", and so do the calls this agent logs.",
  `2. Any other call on the client - on their contact, on any of their deals, or to their number - logged from ${S.WINDOW_BEFORE_MINUTES} minute before the Ziwo call started until ${S.WINDOW_AFTER_MINUTES} minutes after it. Example: Ziwo call at 11:19; a call logged between 11:18 and 11:49 means it is already there.`,
  "A call that carries a Ziwo call id only stands for its own Ziwo call. So three dial attempts with nothing logged become three calls, and one call the consultant logged by hand covers every attempt in the 30 minutes before it.",
  "If neither, the call is logged.",
  "The outcome",
  `Connected: the client answered and they talked for ${S.CONNECTED_MIN_TALK_SECONDS} seconds or more.`,
  "Busy: Ziwo says the line was busy, or the client rejected the call.",
  `No answer: everything else - rang out, not picked up, switched off, hung up before anyone answered, or answered for under ${S.CONNECTED_MIN_TALK_SECONDS} seconds (Ziwo itself calls those phantom calls).`,
  "Which calls",
  `Calls consultants make: ${S.LOG_OUTBOUND ? "all of them" : "none (switched off)"}. Calls clients make to HOF: ${S.LOG_INBOUND === "none" ? "none (switched off)" : "only when a consultant answered"}. Missed incoming calls and calls between colleagues are never logged.`,
  "Which consultant",
  "The call goes under the HubSpot user who made it. Each Ziwo user is matched to a HubSpot user in this order: set by hand in config.js; the same email; learned from the calls the Ziwo app already logged for them; the same name before the @; the same full name (only when exactly one HubSpot user has it). Not matched means not logged, and the email says who.",
  "Which client",
  "The number from Ziwo is put in international form and looked for on every contact's Phone number, Mobile phone number, Mobile number and WhatsApp phone number, however it was typed. The same number, or the same local number saved without the country code, is a match. The same digits under another country code, or numbers that only start the same way, are not.",
  "When the number is on several contacts, the call goes on the one owned by the consultant who made the call; if none is theirs, on the one worked on most recently. All of them are checked for an existing call first. A number on no contact is not logged and is listed on the Not in HubSpot tab.",
  "How the call looks in HubSpot",
  `On the client's contact${S.ASSOCIATE_OPEN_DEALS ? " and on any of their deals that are still open" : ""}, at the time the Ziwo call started. Title "Call with <client>", first line "Call id : <Ziwo call id>" (like the Ziwo app's calls), second line "${D.MARKER}". The outcome, the direction, the talk time and the numbers are filled in.`,
  "Safety",
  "Nothing is ever logged twice: every run first looks for the Ziwo call id. If HubSpot does not confirm a call was saved, it is reported, and running the agent again for that date finishes the job. Nothing else in HubSpot is ever changed.",
];

async function main() {
  const t0 = Date.now();
  const mode = modeOf();
  const r = range();
  const span = r.fromYmd === r.toYmd ? r.fromYmd : `${r.fromYmd} to ${r.toYmd}`;
  console.log(`Ziwo call log - ${mode.toUpperCase()} - ${span} (Dubai time)${r.cut ? " - up to 30 minutes ago" : ""}`);
  if (!process.env.HUBSPOT_TOKEN) throw new Error("The HUBSPOT_TOKEN secret is missing.");

  // ---- 1. Ziwo
  const zUsers = await Z.agents();
  const z = await Z.calls(r.from, r.to);
  console.log(`Ziwo: ${z.calls.length} calls (${z.read} records in ${z.pages} pages, ${Z.state.requests} requests), ${zUsers.length} users`);

  // ---- 2. HubSpot: users, outcomes, and every call around these dates
  const scopes = await H.tokenScopes();
  const owners = await H.owners();
  const disp = await H.dispositions();
  const dispositions = {};
  for (const [lbl, fallback] of Object.entries(S.DISPOSITIONS)) dispositions[lbl] = disp.byLabel[lbl.toLowerCase()] || fallback;
  const hubspotCalls = await H.callsBetween(r.from - S.WINDOW_BEFORE_MINUTES * 60e3, r.to + S.WINDOW_AFTER_MINUTES * 60e3);
  const ziwoIds = D.byZiwoId(hubspotCalls);
  console.log(`HubSpot: ${hubspotCalls.length} calls around these dates, ${ziwoIds.size} with a Ziwo call id, ${owners.length} users`);

  // ---- 3. learn from the calls the Ziwo app already logged
  const cal = D.calibrate(z.calls, ziwoIds);
  const hof = D.hofNumbers(z.calls);
  const pairs = D.appPairs(z.calls, ziwoIds);
  const agentsById = new Map(zUsers.map((a) => [a.id, a]));
  for (const c of z.calls) {
    if (c.agent && c.agent.id && !agentsById.has(c.agent.id)) agentsById.set(c.agent.id, c.agent);
    if (c.agentId && !agentsById.has(c.agentId)) agentsById.set(c.agentId, { id: c.agentId, firstName: "", lastName: "", username: "", email: "" });
  }
  const learned = learn(pairs);
  const people = matchAgents([...agentsById.values()], owners, learned);

  // ---- 4. the clients
  const open = z.calls.filter((c) => !(ziwoIds.get(c.id.toLowerCase()) || []).length &&
    ((c.direction === "outbound" && S.LOG_OUTBOUND) || (c.direction === "inbound" && S.LOG_INBOUND !== "none" && c.answered)));
  const numbers = [...new Set(open.map((c) => D.clientNumberOf(c, cal, hof)).filter(Boolean).map((x) => x.e164))];
  const found = await H.contactsByNumbers(numbers);
  const index = indexContacts(found.contacts);
  const matchedIds = [...new Set(numbers.flatMap((e) => contactsFor(e, index).map((m) => m.id)))];
  const { byContact: dealsByContact, deals } = await H.dealsOf(matchedIds);
  console.log(`Clients: ${numbers.length} numbers, ${matchedIds.length} contacts hold one of them, ${deals.size} deals`);

  // ---- 5. decide, then log
  const ownerNames = new Map(owners.map((o) => [o.id, o.name]));
  const rows = D.decide({ calls: z.calls, hubspotCalls, ziwoIds, people, index, contacts: found.contacts, dealsByContact, deals,
    dispositions, cal, hof, agentsById, ownerNames });
  const toLog = rows.filter((x) => x.status === "To log");
  if (mode === "live" && toLog.length) {
    const created = await H.createCalls(toLog.map((x) => x.input));
    for (const x of toLog) {
      const got = created.get(x.input.key);
      if (got && got.id) { x.status = "Logged"; x.hubspotCallId = got.id; }
      else { x.status = "Could not log"; x.detail = (got && got.error) || "HubSpot did not answer"; }
    }
  } else {
    toLog.forEach((x) => { x.status = "Would log"; });
  }

  // ---- 6. the report
  const count = (f) => rows.filter(f).length;
  const isLogged = (x) => x.status === "Logged" || x.status === "Would log";
  const k = {
    total: rows.length,
    already: count((x) => x.status === "Already in HubSpot"),
    byApp: count((x) => x.status === "Already in HubSpot" && /Ziwo app/.test(x.detail)),
    byUs: count((x) => x.status === "Already in HubSpot" && /this agent/.test(x.detail)),
    logged: count(isLogged),
    Connected: count((x) => isLogged(x) && x.outcome === "Connected"),
    "No answer": count((x) => isLogged(x) && x.outcome === "No answer"),
    Busy: count((x) => isLogged(x) && x.outcome === "Busy"),
    notLogged: count((x) => x.status === "Not logged"),
    notInHubspot: count((x) => x.detail === "Number not in HubSpot"),
    notInHubspotNumbers: new Set(rows.filter((x) => x.detail === "Number not in HubSpot").map((x) => x.number)).size,
    noOwner: count((x) => /^Consultant not matched/.test(x.detail)),
    failed: count((x) => x.status === "Could not log"),
    skipped: count((x) => x.status === "Skipped"),
  };
  k.byPeople = k.already - k.byApp - k.byUs;
  k.noNumber = k.notLogged - k.notInHubspot - k.noOwner;

  const consultants = [...agentsById.values()].map((a) => {
    const mine = rows.filter((x) => x.call.agentId === a.id);
    const who = people.get(a.id) || {};
    return { id: a.id, name: fullName(a) || a.username || `Ziwo user ${a.id}`, username: a.username || a.email || "", owner: who.ownerName || "",
      how: who.how || "", note: who.note || "", skip: Boolean(who.skip), calls: mine.length,
      already: mine.filter((x) => x.status === "Already in HubSpot").length, logged: mine.filter(isLogged).length,
      notLogged: mine.filter((x) => x.status === "Not logged" || x.status === "Could not log").length,
      skipped: mine.filter((x) => x.status === "Skipped").length };
  }).filter((p) => p.calls || !p.owner).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  // checks: how Ziwo was read this time
  const fieldsSeen = [...new Set(z.calls.flatMap((c) => c.fields))].sort();
  const results = new Map(); z.calls.forEach((c) => { const key = c.result || c.hangupCause || "(blank)"; results.set(key, (results.get(key) || 0) + 1); });
  const calLine = (dir) => {
    const x = cal[dir];
    if (S.CLIENT_NUMBER_FIELD !== "auto") return `Set by hand in config.js: "${S.CLIENT_NUMBER_FIELD}".`;
    return x.field
      ? `Read from Ziwo's "${x.field}" field. Checked against ${n(x.pairs)} ${dir} calls the Ziwo app logged in HubSpot: the same number on ${n(x.matched)}.`
      : `Could not be checked (${n(x.pairs)} ${dir} calls logged by the Ziwo app to compare with). Used the first of ${dir === "outbound" ? "targetNumber, didCalled, contactNumber" : "callerIDNumber, contactNumber"} that is not a HOF line. If the Calls tab shows HOF's own number as the client, set CLIENT_NUMBER_FIELD in config.js.`;
  };
  const versus = new Map();
  for (const p of pairs) {
    const theirs = disp.byId[p.hub.disposition] || (p.hub.disposition ? "other" : "(none)");
    const key = `Ziwo app: ${theirs} -> here: ${D.outcomeOf(p.call)}`;
    versus.set(key, (versus.get(key) || 0) + 1);
  }
  const agree = pairs.filter((p) => (disp.byId[p.hub.disposition] || "") === D.outcomeOf(p.call)).length;
  const how = {}; for (const p of people.values()) how[p.how.split(":")[0]] = (how[p.how.split(":")[0]] || 0) + 1;
  const canWrite = (scopes || []).filter((x) => /^crm\.objects\.(calls|contacts)\.write$/.test(x));
  const checks = [
    ["Run", `${mode} · ${span} (Dubai time)${r.cut ? " · calls from the last 30 minutes left for the next run" : ""} · took ${Math.round((Date.now() - t0) / 1000)} s`],
    ["Ziwo", `${Z.state.from === "key" ? "ZIWO_API_KEY" : "Signed in as ZIWO_USERNAME"} at ${Z.state.base}. ${n(z.read)} call records read in ${z.pages} pages; ${n(z.calls.length)} calls on these dates.${z.dated ? "" : " Ziwo refused the date filter, so calls were read without it."}${z.cappedOut ? ` STOPPED after ${S.ZIWO_MAX_PAGES} pages - some calls may be missing.` : ""}`],
    ["Client's number - outgoing calls", calLine("outbound")],
    ["Client's number - incoming calls", calLine("inbound")],
    ["HOF's own numbers (never a client)", hof.size ? [...hof.entries()].map(([e, why]) => `${pretty(e)} (${why})`).join("; ") : "None found."],
    ["Consultants", `${n(agentsById.size)} Ziwo users on these calls or in Ziwo's user list. Matched: ${Object.entries(how).map(([h, c]) => `${h} ${c}`).join(" · ")}.`],
    ["Outcome compared with the Ziwo app", pairs.length
      ? `${n(agree)} of ${n(pairs.length)} calls the Ziwo app logged get the same outcome here. ${[...versus.entries()].sort((a, b) => b[1] - a[1]).map(([kk, v]) => `${kk}: ${n(v)}`).join(" · ")}.${versus.get("Ziwo app: Busy -> here: No answer") ? " The Ziwo app marks unanswered calls Busy; this agent tells No answer from Busy using Ziwo's own result." : ""}`
      : "No calls logged by the Ziwo app to compare with."],
    ["Ziwo results seen", [...results.entries()].sort((a, b) => b[1] - a[1]).map(([kk, v]) => `${kk} ${n(v)}`).join(" · ") || "-"],
    ["Fields in Ziwo's call records", fieldsSeen.join(", ") || "-"],
    ["HubSpot", `${n(hubspotCalls.length)} calls around these dates, ${n(ziwoIds.size)} with a Ziwo call id. ${n(found.contacts.size)} contacts read to find ${n(numbers.length)} numbers. ${H.stats.calls} requests.${found.notes.length ? ` ${found.notes.join(" ")}` : ""}`],
    ["HubSpot permission to log calls", scopes === null
      ? "HubSpot did not say what the token may do. The first live run will tell: if it stops with \"missing a permission\", see the README."
      : canWrite.length ? `Yes - the token has ${canWrite.join(", ")}.` : "NO - the token cannot write calls yet. Add the calls/contacts write permission to the private app (see the README) before going live."],
    ["Settings", `window ${S.WINDOW_BEFORE_MINUTES} min before to ${S.WINDOW_AFTER_MINUTES} min after · Connected from ${S.CONNECTED_MIN_TALK_SECONDS} s · incoming calls: ${S.LOG_INBOUND} · client number field: ${S.CLIENT_NUMBER_FIELD} · open deals linked: ${S.ASSOCIATE_OPEN_DEALS ? "yes" : "no"}`],
  ];
  const warnings = [];
  if (z.cappedOut) warnings.push(`Ziwo had more calls than the ${S.ZIWO_MAX_PAGES}-page limit - some calls may be missing. Run fewer days at once.`);
  if (!z.dated) warnings.push("Ziwo did not accept the date filter; calls were read without it. Check the Calls tab covers the right day.");
  if (!z.calls.length && z.read) warnings.push(`Ziwo returned ${n(z.read)} calls around these dates but none on the day itself.`);
  found.notes.forEach((x) => warnings.push(x));
  if (scopes && !canWrite.length) warnings.push("The HubSpot token cannot write calls yet, so a live run would stop. Add the permission first (README, \"HubSpot permission\").");
  const pick = (name) => (checks.find((c) => c[0] === name) || ["", ""])[1];
  const emailChecks = [["Client's number (outgoing calls)", pick("Client's number - outgoing calls")], ["Outcome check", pick("Outcome compared with the Ziwo app")],
    ["Consultants", pick("Consultants")], ["HubSpot permission to log calls", pick("HubSpot permission to log calls")]].map(([a, b]) => `${a}: ${b}`);

  const rep = { mode, from: r.fromYmd, to: r.toYmd, dayLabel: label(r.fromYmd), toLabel: label(r.toYmd), rows, counts: k, consultants,
    checks, emailChecks, warnings, rules: RULES() };
  fs.mkdirSync(S.OUT_DIR, { recursive: true });
  const file = path.join(S.OUT_DIR, `ziwo-call-log-${r.fromYmd}${r.toYmd !== r.fromYmd ? `_to_${r.toYmd}` : ""}${mode === "live" ? "" : "-dry-run"}.xlsx`);
  await build(rep, file);
  const html = buildEmail(rep);
  fs.writeFileSync(path.join(S.OUT_DIR, "email.html"), html);
  fs.writeFileSync(path.join(S.OUT_DIR, "summary.json"), JSON.stringify({ mode, span, counts: k }, null, 2));
  const subject = `${mode === "live" ? "" : "[Dry run] "}Ziwo call log - ${rep.dayLabel}${r.toYmd !== r.fromYmd ? ` to ${rep.toLabel}` : ""}: ${n(k.logged)} ${mode === "live" ? "logged" : "to log"}, ${n(k.notLogged)} not logged`;
  const sent = await sendEmail(subject, html, { filename: path.basename(file), content: fs.readFileSync(file).toString("base64") });

  console.log([
    `Already in HubSpot ${k.already} (Ziwo app ${k.byApp}, people ${k.byPeople}, this agent ${k.byUs})`,
    `${mode === "live" ? "Logged" : "Would log"} ${k.logged} (Connected ${k.Connected}, No answer ${k["No answer"]}, Busy ${k.Busy})`,
    `Not logged ${k.notLogged} (number not in HubSpot ${k.notInHubspot}, consultant not matched ${k.noOwner}, other ${k.noNumber})`,
    `Could not log ${k.failed} · Skipped ${k.skipped}`,
    `Email ${sent ? "sent" : "not sent"} · ${file}`,
  ].join("\n"));
  if (k.failed) process.exitCode = 1;     // a red run in GitHub, so a half-finished day is noticed
  return rep;
}

if (require.main === module) {
  main().catch(async (e) => {
    console.error(`\nThe Ziwo call log stopped: ${e.message}`);
    try {
      await sendEmail("Ziwo call log stopped", `<p style="font:14px Arial">The Ziwo call log stopped before finishing:</p><p style="font:14px Arial;color:#b42318"><b>${String(e.message).replace(/</g, "&lt;")}</b></p><p style="font:13px Arial;color:#555">Run it again for the same date once this is fixed: calls already logged are recognised and never logged twice. The README says what each message means.</p>`);
    } catch { /* the GitHub run is red anyway */ }
    process.exit(1);
  });
}

module.exports = { main, range, modeOf };
