// selftest.js — every rule, then a whole day replayed against a pretend Ziwo and a pretend
// HubSpot (dry run, live run, and a second live run that must log nothing twice).
// It runs before every real run; if a rule is broken, nothing is logged that day.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { SETTINGS: S } = require("./config");

// no waiting between pretend requests, no real files left behind
S.SEARCH_RPS = 1e6; S.API_RPS = 1e6; S.ZIWO_PAGE_SIZE = 10;
S.OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ziwo-call-log-"));
const original = { overrides: S.AGENT_OVERRIDES, hof: S.HOF_NUMBERS, field: S.CLIENT_NUMBER_FIELD };

const P = require("./2-phone");
const D = require("./4-decide");
const { matchAgents, learn } = require("./3-people");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; } catch (e) { failed++; console.log(`FAIL  ${name}\n      ${e.message.split("\n").join("\n      ")}`); }
}
const at = (hms, day = "2026-11-17") => Date.parse(`${day}T${hms}+04:00`);   // Dubai time
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

if (require.main === module) (async () => {
  // ================================================================ numbers
  await test("numbers are read however they are typed", () => {
    const e = (s) => (P.read(s) || {}).e164;
    for (const s of ["+971 50 123 4567", "00971501234567", "971501234567", "0501234567", "501234567", "+971 (0)50-123-4567"]) assert.strictEqual(e(s), "+971501234567", s);
    assert.strictEqual(e("966563497038"), "+966563497038");
    assert.strictEqual(e("00966538238193"), "+966538238193");
    assert.strictEqual(e("+966 0579535592"), "+966579535592");
    assert.strictEqual(e("+923001234567 ext 923453287800"), "+923001234567");
    assert.strictEqual(e("917006474403"), "+917006474403");
    assert.strictEqual(P.read("12345"), null);
    assert.strictEqual(P.read("0551752664").local, true);
    assert.strictEqual(P.read("971501234567").local, false);
  });
  await test("two numbers in one box are both read", () => {
    assert.deepStrictEqual(P.readAll("+971503035236 , +971507148071 | 0551752664").map((x) => x.e164), ["+971503035236", "+971507148071", "+971551752664"]);
    assert.deepStrictEqual(P.readAll(" +971547009233 / +923004120952").map((x) => x.e164), ["+971547009233", "+923004120952"]);
  });
  await test("a client is matched on the same number only", () => {
    const idx = P.indexContacts(new Map([
      ["1", { phone: "+971551752664" }], ["2", { phone: "0551752664" }], ["3", { mobilephone: "966 551752664" }],
      ["4", { phone: "+97155175266" }], ["5", { hs_whatsapp_phone_number: "+971551752664" }], ["6", { mobile_number: "00971 55 175 2664" }],
    ]));
    const uae = P.contactsFor("+971551752664", idx);
    assert.deepStrictEqual(uae.map((m) => m.id).sort(), ["1", "2", "5", "6"]);
    assert.strictEqual(uae.find((m) => m.id === "2").how, "Same number, saved without the country code");
    const ksa = P.contactsFor("+966551752664", idx);
    assert.deepStrictEqual(ksa.map((m) => m.id).sort(), ["2", "3"]);          // same digits under +971 do not count
    assert.deepStrictEqual(P.contactsFor("+97455267947", P.indexContacts(new Map([["9", { phone: "+971552679479" }]]))), []); // only starts the same
  });

  // ================================================================ outcome
  await test("outcome: Connected, Busy, No answer", () => {
    const o = (x) => D.outcomeOf({ answered: false, talk: 0, result: "", hangupCause: "", ...x });
    assert.strictEqual(o({ answered: true, talk: 120 }), "Connected");
    assert.strictEqual(o({ answered: true, talk: 10 }), "Connected");
    assert.strictEqual(o({ answered: true, talk: 9 }), "No answer");             // under 10 seconds
    assert.strictEqual(o({ result: "busy" }), "Busy");
    assert.strictEqual(o({ hangupCause: "USER_BUSY" }), "Busy");
    assert.strictEqual(o({ hangupCause: "CALL_REJECTED" }), "Busy");
    assert.strictEqual(o({ result: "cancel", hangupCause: "ORIGINATOR_CANCEL" }), "No answer");
    assert.strictEqual(o({ result: "no-answer", hangupCause: "NO_ANSWER" }), "No answer");
  });

  // ================================================================ the 30-minute rule
  await test("the window: 1 minute before to 30 minutes after the Ziwo call", () => {
    const start = at("11:19:05");
    const calls = (times) => D.indexManual(times.map((t, i) => ({ id: String(i), at: t, body: "", contacts: ["c1"], deals: [], to: "", from: "" })));
    const cover = (t) => D.coveringCall(start, ["c1"], [], "+971500000000", calls([t]));
    assert.ok(cover(at("11:19:05")), "same moment");
    assert.ok(cover(at("11:30:00")), "11:30");
    assert.ok(cover(at("11:49:05")), "exactly 30 minutes after");
    assert.ok(!cover(at("11:49:06")), "one second past 30 minutes");
    assert.ok(cover(at("11:18:05")), "exactly 1 minute before");
    assert.ok(!cover(at("11:18:04")), "more than 1 minute before");
  });
  await test("the window looks at the contact, the deals and the number", () => {
    const start = at("15:00:00");
    const idx = D.indexManual([
      { id: "d", at: at("15:10"), body: "", contacts: [], deals: ["deal9"], to: "", from: "" },
      { id: "n", at: at("15:12"), body: "", contacts: [], deals: [], to: "+971505050505", from: "" },
    ]);
    assert.strictEqual(D.coveringCall(start, [], ["deal9"], "+971500000001", idx).where, "deal");
    assert.strictEqual(D.coveringCall(start, [], [], "+971505050505", idx).where, "number");
    assert.strictEqual(D.coveringCall(start, ["c1"], ["deal1"], "+971500000001", idx), null);
  });
  await test("a call with a Ziwo call id only stands for its own Ziwo call", () => {
    const hub = [
      { id: "1", at: at("11:20"), body: `<p>Call id : ${uuid(7)}</p>`, contacts: ["c1"], deals: [], to: "", from: "" },
      { id: "2", at: at("11:25"), body: "Call id : EE4D3DE6-6991-446F-9200-3D12F7AAFC27", contacts: [], deals: [], to: "", from: "" },
      { id: "3", at: at("11:21"), body: `<p>Call id : ${uuid(8)}</p><p>${D.MARKER} - it was not logged in HubSpot.</p>`, contacts: ["c1"], deals: [], to: "", from: "" },
    ];
    const ids = D.byZiwoId(hub);
    assert.ok(ids.has(uuid(7)) && ids.has("ee4d3de6-6991-446f-9200-3d12f7aafc27"));
    assert.strictEqual(ids.get(uuid(8))[0].ours, true);
    assert.strictEqual(D.coveringCall(at("11:19"), ["c1"], [], "+971500000002", D.indexManual(hub)), null);
  });

  // ================================================================ consultants
  const owners = [
    { id: "o1", email: "aisha.khan@hofmigration.com", name: "Aisha Khan" },
    { id: "o2", email: "saadaman@hofmigration.com", name: "Saad Aman" },
    { id: "o3", email: "bilal@hofmigration.com", name: "Bilal Ahmed" },
    { id: "o4", email: "danish@hofmigration.com", name: "Danish Anwar" },
    { id: "o5", email: "aliraza@hofmigration.com", name: "Ali Raza" },
    { id: "o6", email: "razaali@hofmigration.com", name: "Ali Raza" },
  ];
  await test("consultants: email, learned, name before @, full name, never a guess", () => {
    const learned = learn([...Array(5)].map(() => ({ agentId: "D", ownerId: "o4" })));
    const m = matchAgents([
      { id: "A", firstName: "Aisha", lastName: "K", username: "Aisha.Khan@hofmigration.com", email: "aisha.khan@hofmigration.com" },
      { id: "B", firstName: "S", lastName: "A", username: "saadaman", email: "" },
      { id: "C", firstName: "Bilal", lastName: "Ahmed", username: "c.agent7", email: "" },
      { id: "D", firstName: "D.", lastName: "A.", username: "ext-4411", email: "" },
      { id: "E", firstName: "Ali", lastName: "Raza", username: "ali.r", email: "" },
      { id: "F", firstName: "Test", lastName: "Agent", username: "test@hofmigration.com", email: "test@hofmigration.com" },
      { id: "G", firstName: "New", lastName: "Person", username: "np", email: "" },
    ], owners, learned, { "test@hofmigration.com": "skip", G: "bilal@hofmigration.com" });
    assert.strictEqual(m.get("A").ownerId, "o1"); assert.strictEqual(m.get("A").how, "Same email");
    assert.strictEqual(m.get("B").ownerId, "o2"); assert.strictEqual(m.get("B").how, "Same name before the @");
    assert.strictEqual(m.get("C").ownerId, "o3"); assert.strictEqual(m.get("C").how, "Same full name");
    assert.strictEqual(m.get("D").ownerId, "o4"); assert.match(m.get("D").how, /^Learned/);
    assert.strictEqual(m.get("E").ownerId, "");   assert.match(m.get("E").note, /More than one HubSpot user is called Ali Raza/);
    assert.strictEqual(m.get("F").skip, true);
    assert.strictEqual(m.get("G").ownerId, "o3"); assert.strictEqual(m.get("G").how, "Set by hand in config.js");
  });
  await test("learning needs 2 calls and 80% agreement", () => {
    const l = learn([{ agentId: "X", ownerId: "o1" }, { agentId: "Y", ownerId: "o1" }, { agentId: "Y", ownerId: "o1" },
      { agentId: "Z", ownerId: "o1" }, { agentId: "Z", ownerId: "o2" }, { agentId: "Z", ownerId: "o1" }]);
    assert.strictEqual(l.get("X").trusted, false);
    assert.strictEqual(l.get("Y").trusted, true);
    assert.strictEqual(l.get("Z").trusted, false);   // 2 of 3
  });

  // ================================================================ which contact
  await test("duplicates: the consultant's own contact, else the one worked on most recently", () => {
    const contacts = new Map([["a", { hubspot_owner_id: "o1", notes_last_contacted: "2026-11-16T10:00:00Z" }],
      ["b", { hubspot_owner_id: "o2", notes_last_contacted: "2026-11-01T10:00:00Z" }],
      ["c", { hubspot_owner_id: "o3", notes_last_contacted: "2026-11-10T10:00:00Z" }]]);
    const matches = [{ id: "a", how: "Same number" }, { id: "b", how: "Same number, saved without the country code" }, { id: "c", how: "Same number" }];
    assert.strictEqual(D.pickContact(matches, "o2", contacts).id, "b");
    assert.strictEqual(D.pickContact(matches, "o9", contacts).id, "a");
  });

  // ================================================================ the dates
  await test("the daily run covers yesterday, Dubai time", () => {
    const { range } = require("./run");
    const keep = { f: process.env.FROM_DATE, t: process.env.TO_DATE };
    delete process.env.FROM_DATE; delete process.env.TO_DATE;
    const r = range(Date.parse("2026-11-18T03:30:00Z"));          // 07:30 in Dubai on the 18th
    assert.strictEqual(r.fromYmd, "2026-11-17");
    assert.strictEqual(r.from, Date.parse("2026-11-17T00:00:00+04:00"));
    assert.strictEqual(r.to, Date.parse("2026-11-18T00:00:00+04:00"));
    process.env.FROM_DATE = "2026-11-01"; process.env.TO_DATE = "2026-11-03";
    const s = range(Date.parse("2026-11-18T03:30:00Z"));
    assert.strictEqual(s.days, 3);
    process.env.FROM_DATE = "2026-10-01"; process.env.TO_DATE = "2026-11-17";
    assert.throws(() => range(Date.parse("2026-11-18T03:30:00Z")), /At most/);
    process.env.FROM_DATE = "2026-11-18"; delete process.env.TO_DATE;
    const today = range(Date.parse("2026-11-18T08:00:00Z"));      // 12:00 in Dubai: stops 30 minutes ago
    assert.strictEqual(today.to, Date.parse("2026-11-18T07:30:00Z"));
    process.env.FROM_DATE = keep.f || ""; process.env.TO_DATE = keep.t || "";
    if (!keep.f) delete process.env.FROM_DATE; if (!keep.t) delete process.env.TO_DATE;
  });

  // ================================================================ a whole day, end to end
  const world = buildWorld();
  const realFetch = global.fetch;
  global.fetch = (url, opts) => world.fetch(url, opts);
  Object.assign(process.env, { HUBSPOT_TOKEN: "test", ZIWO_INSTANCE: "https://hof.ziwo.io", ZIWO_API_KEY: "OLD-KEY", ZIWO_USERNAME: "admin@hof", ZIWO_PASSWORD: "pw",
    RESEND_KEY: "test", FROM_DATE: "2026-11-17", TO_DATE: "" });
  S.AGENT_OVERRIDES = { "test@hofmigration.com": "skip" };
  const { main } = require("./run");
  const Z = require("./0-ziwo");
  const quiet = console.log; console.log = () => {};
  const runAs = async (stage, mode) => { world.stage = stage; process.env.MODE = mode; Z.state.token = null; Z.state.from = ""; return main(); };
  let dry, live, again;
  try {
    dry = await runAs("dry", "dry-run");
    live = await runAs("live", "live");
    again = await runAs("again", "live");
  } finally { console.log = quiet; global.fetch = realFetch; }

  const row = (rep, key) => rep.rows.find((x) => x.call.id === uuid(world.ids[key]));
  await test("e2e: Ziwo's old key is refused, it signs in instead and reads every page", () => {
    assert.strictEqual(world.logins, 3);                 // once per run
    assert.ok(world.pagesRead > 6, `pages read: ${world.pagesRead}`);
    assert.strictEqual(dry.rows.length, 54, `calls on the day: ${dry.rows.length}`);
  });
  await test("e2e: dry run logs nothing and counts right", () => {
    assert.strictEqual(world.createdIn.dry, 0);
    const k = dry.counts;
    assert.deepStrictEqual([k.total, k.already, k.byApp, k.byPeople, k.byUs, k.logged, k.Connected, k["No answer"], k.Busy, k.notLogged, k.notInHubspot, k.noOwner, k.noNumber, k.skipped, k.failed],
      [54, 36, 31, 5, 0, 11, 6, 3, 2, 4, 2, 1, 1, 3, 0]);
    assert.strictEqual(row(dry, "S1").status, "Would log");
  });
  await test("e2e: the client's number is read from the right Ziwo field, HOF lines are not clients", () => {
    assert.ok(dry.checks.find((c) => c[0] === "Client's number - outgoing calls")[1].includes('"didCalled"'));
    assert.ok(dry.checks.find((c) => c[0] === "HOF's own numbers (never a client)")[1].includes("+971 4 200 0000"));
    assert.strictEqual(row(dry, "S22").detail, "Ziwo has no client number on this call");
  });
  await test("e2e: each case is decided as the rules say", () => {
    const d = (k) => { const x = row(dry, k); return `${x.status} | ${x.detail}`; };
    assert.match(d("S4"), /^Already in HubSpot \| Bilal Ahmed logged a call on their contact at 11:30/);
    assert.match(d("S5"), /^Would log/);
    assert.match(d("S6"), /^Already in HubSpot \| .* at 11:18/);
    assert.match(d("S7"), /^Would log/);
    assert.match(d("S8"), /^Already in HubSpot \| Logged by the Ziwo app/);
    assert.match(d("S9"), /^Not logged \| Number not in HubSpot/);
    assert.match(d("S10"), /^Not logged \| Consultant not matched/);
    assert.match(d("S12"), /^Skipped \| Missed incoming call/);
    assert.match(d("S13"), /^Skipped \| Internal call/);
    assert.match(d("S17"), /^Not logged \| Number not in HubSpot/);
    assert.match(d("S18"), /^Already in HubSpot \| .* on their deal at 15:10/);
    assert.match(d("S19"), /^Already in HubSpot \| .* to their number at 15:35/);
    assert.match(d("S21"), /^Skipped \| This Ziwo user is skipped/);
    assert.match(d("S24"), /^Already in HubSpot \| .* at 00:10/);
    assert.strictEqual(row(dry, "S20").outcome, "No answer");
  });
  await test("e2e: live run logs the 11 missing calls exactly", () => {
    assert.strictEqual(world.createdIn.live, 11);
    assert.strictEqual(live.counts.logged, 11);
    const s1 = world.createdCall(uuid(world.ids.S1));
    assert.strictEqual(s1.properties.hubspot_owner_id, "o1");
    assert.strictEqual(s1.properties.hs_call_disposition, "f240bbac-87c9-4f6e-bf70-924b57d47db7");
    assert.strictEqual(s1.properties.hs_call_status, "COMPLETED");
    assert.strictEqual(s1.properties.hs_call_direction, "OUTBOUND");
    assert.strictEqual(s1.properties.hs_call_duration, "120000");
    assert.strictEqual(s1.properties.hs_call_to_number, "+971501111111");
    assert.strictEqual(s1.properties.hs_call_from_number, "+97142000000");
    assert.strictEqual(s1.properties.hs_timestamp, new Date(at("10:00:00")).toISOString());
    assert.strictEqual(s1.properties.hs_call_title, "Call with Client One");
    assert.ok(s1.properties.hs_call_body.startsWith(`<p>Call id : ${uuid(world.ids.S1)}</p>`));
    assert.deepStrictEqual(s1.contacts, ["c1"]);
    assert.deepStrictEqual(s1.deals, ["d1"]);            // the open deal, not the closed one
    const s2 = world.createdCall(uuid(world.ids.S2));
    assert.strictEqual(s2.properties.hs_call_disposition, "73a0d17f-1163-4015-bdd5-ec830791da20");
    assert.strictEqual(s2.properties.hs_call_status, "NO_ANSWER");
    const s3 = world.createdCall(uuid(world.ids.S3));
    assert.strictEqual(s3.properties.hs_call_disposition, "9d9162e7-6cf3-4944-bf63-4dff82258764");
    assert.strictEqual(s3.properties.hubspot_owner_id, "o2");
    const s11 = world.createdCall(uuid(world.ids.S11));
    assert.strictEqual(s11.properties.hs_call_direction, "INBOUND");
    assert.strictEqual(s11.properties.hs_call_from_number, "+971509999999");
    assert.strictEqual(s11.properties.hs_call_to_number, "+97142000001");
    assert.deepStrictEqual(world.createdCall(uuid(world.ids.S14)).contacts, ["c11"]);   // the consultant's own duplicate
    assert.deepStrictEqual(world.createdCall(uuid(world.ids.S15)).contacts, ["c13"]);   // the most recently worked duplicate
    const s16 = world.createdCall(uuid(world.ids.S16));
    assert.strictEqual(s16.properties.hubspot_owner_id, "o4");                          // learned from the Ziwo app
    assert.deepStrictEqual(s16.contacts, ["c14"]);                                      // saved without country code
    assert.ok(world.createdCall(uuid(world.ids.S23)), "a call in two parts is logged once");
  });
  await test("e2e: running again logs nothing twice", () => {
    assert.strictEqual(world.createdIn.again, 0);
    assert.strictEqual(again.counts.byUs, 11);
    assert.strictEqual(again.counts.logged, 0);
  });
  await test("e2e: the dry run says whether the HubSpot token can log calls", () => {
    assert.match(dry.checks.find((c) => c[0] === "HubSpot permission to log calls")[1], /^Yes - the token has crm\.objects\.contacts\.write/);
  });
  await test("e2e: the email went out with the sheet attached", () => {
    assert.strictEqual(world.emails.length, 3);
    assert.match(world.emails[0].subject, /^\[Dry run\] Ziwo call log - Tue 17 Nov 2026: 11 to log, 4 not logged$/);
    assert.match(world.emails[1].subject, /^Ziwo call log - Tue 17 Nov 2026: 11 logged/);
    assert.ok(world.emails[1].attachments[0].filename.endsWith(".xlsx"));
    assert.match(world.emails[0].html, /Ali Raza/);                                      // the unmatched consultant is named
  });

  // ================================================================ HubSpot saying no
  await test("a refused batch is tried call by call; an unconfirmed one is never repeated", async () => {
    const H = require("./1-hubspot");
    const w = buildWorld();
    global.fetch = (url, opts) => w.fetch(url, opts);
    try {
      const item = (n) => ({ key: uuid(900 + n), contactId: "c1", dealIds: [], properties: { hs_timestamp: new Date(at("09:00")).toISOString(), hs_call_body: `<p>Call id : ${uuid(900 + n)}</p>` } });
      w.failNext = 400;
      let out = await H.createCalls([item(1), item(2)]);
      assert.ok(out.get(uuid(901)).id && out.get(uuid(902)).id, "400: logged one by one");
      w.failNext = 500;
      out = await H.createCalls([item(3)]);
      assert.match(out.get(uuid(903)).error, /did not confirm/);
      assert.strictEqual(w.createdCall(uuid(903)), undefined, "500: not repeated");
      w.noTrace = true;
      out = await H.createCalls([item(4), item(5)]);
      assert.ok(out.get(uuid(904)).id && out.get(uuid(905)).id, "matched back by the call id in the text");
    } finally { global.fetch = realFetch; }
  });

  S.AGENT_OVERRIDES = original.overrides; S.HOF_NUMBERS = original.hof; S.CLIENT_NUMBER_FIELD = original.field;
  fs.rmSync(S.OUT_DIR, { recursive: true, force: true });
  console.log(`selftest: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
})().catch((e) => { console.log(`selftest crashed: ${e.stack}`); process.exit(1); });

// =================================================================== the pretend world
function buildWorld() {
  const { parsePhoneNumberFromString } = require("libphonenumber-js/max");
  const W = { cdrs: [], agents: [], owners: [], contacts: new Map(), deals: new Map(), contactDeals: new Map(), calls: new Map(),
    ids: {}, logins: 0, pagesRead: 0, emails: [], created: [], createdIn: { dry: 0, live: 0, again: 0 }, next: 5000, failNext: 0, noTrace: false };
  let n = 1;
  const HOF_LINE = "+97142000000", HOF_DID = "+97142000001";

  W.agents = [
    { id: 11, firstName: "Aisha", lastName: "K", username: "aisha.khan@hofmigration.com", ccLogin: "1011" },
    { id: 12, firstName: "S", lastName: "A", username: "saadaman", ccLogin: "1012" },
    { id: 13, firstName: "Bilal", lastName: "Ahmed", username: "c.agent7", ccLogin: "1013" },
    { id: 14, firstName: "D.", lastName: "A.", username: "ext-4411", ccLogin: "1014" },
    { id: 15, firstName: "Ali", lastName: "Raza", username: "ali.r", ccLogin: "1015" },
    { id: 16, firstName: "Test", lastName: "Agent", username: "test@hofmigration.com", ccLogin: "1016" },
  ];
  const A = 11, B = 12, C = 13, Dn = 14, E = 15, F = 16;
  W.owners = [
    { id: "o1", email: "aisha.khan@hofmigration.com", firstName: "Aisha", lastName: "Khan", archived: false },
    { id: "o2", email: "saadaman@hofmigration.com", firstName: "Saad", lastName: "Aman", archived: false },
    { id: "o3", email: "bilal@hofmigration.com", firstName: "Bilal", lastName: "Ahmed", archived: false },
    { id: "o4", email: "danish@hofmigration.com", firstName: "Danish", lastName: "Anwar", archived: false },
    { id: "o5", email: "aliraza@hofmigration.com", firstName: "Ali", lastName: "Raza", archived: false },
    { id: "o6", email: "razaali@hofmigration.com", firstName: "Ali", lastName: "Raza", archived: false },
    { id: "o7", email: "gone@hofmigration.com", firstName: "Gone", lastName: "User", archived: true },
  ];
  const OWNER_OF = { [A]: "o1", [B]: "o2", [Dn]: "o4" };

  const contact = (id, props, deals = []) => { W.contacts.set(id, props); W.contactDeals.set(id, deals); };
  const deal = (id, closed) => W.deals.set(id, { dealname: id, hs_is_closed: closed ? "true" : "false" });
  const hubCall = (props, contacts = [], deals = []) => { const id = String(W.next++); W.calls.set(id, { id, properties: props, contacts, deals }); return id; };
  function cdr(key, { agent, dir = "outbound", start, talk = 0, result = "", cause = "", to, from, extra = {} }) {
    const id = n++;
    if (key) W.ids[key] = id;
    const rec = { callID: uuid(id), id: 10000 + id, startedAt: new Date(start).toISOString(), endedAt: new Date(start + (talk + 20) * 1000).toISOString(),
      answeredAt: talk ? new Date(start + 20000).toISOString() : null, talkTime: talk, ringTime: 20, direction: dir, result, hangupCause: cause, ...extra };
    if (agent) { if (id % 2) rec.agentId = agent; else rec.agent = { ...W.agents.find((a) => a.id === agent) }; }
    if (dir === "outbound") { rec.callerIDNumber = HOF_LINE.slice(1); if (to !== undefined) rec.didCalled = to; }
    if (dir === "inbound") { rec.callerIDNumber = from; rec.didCalled = HOF_DID; }
    W.cdrs.push(rec);
    return rec;
  }

  // 30 calls the Ziwo app already logged: teaches the client's field, HOF's line and Danish's HubSpot user
  for (let i = 0; i < 30; i++) {
    const agent = [A, B, Dn][i % 3], num = `+9715090000${String(i).padStart(2, "0")}`;
    const r = cdr(null, { agent, start: at(`09:${String(i).padStart(2, "0")}:00`), talk: i % 4 ? 0 : 40, result: i % 4 ? "cancel" : "answered", to: num.slice(1) });
    hubCall({ hs_timestamp: r.startedAt, hs_call_body: `Call id : ${r.callID}`, hs_call_to_number: num, hubspot_owner_id: OWNER_OF[agent],
      hs_call_disposition: i % 4 ? "9d9162e7-6cf3-4944-bf63-4dff82258764" : "f240bbac-87c9-4f6e-bf70-924b57d47db7", hs_call_direction: "OUTBOUND" });
  }
  // S1 connected, logged on the contact and its open deal only
  deal("d1", false); deal("d2", true);
  contact("c1", { firstname: "Client", lastname: "One", phone: "+971 50 111 1111", hubspot_owner_id: "o1" }, ["d1", "d2"]);
  cdr("S1", { agent: A, start: at("10:00:00"), talk: 120, result: "answered", cause: "NORMAL_CLEARING", to: "+971501111111" });
  // S2 Saudi number saved as 00966..., no answer
  contact("c2", { firstname: "Client", lastname: "Two", phone: "00966502222222", hubspot_owner_id: "o1" });
  cdr("S2", { agent: A, start: at("10:05:00"), result: "cancel", cause: "ORIGINATOR_CANCEL", to: "00966502222222" });
  // S3 local number in Ziwo, 971... with no plus in HubSpot, busy
  contact("c3", { firstname: "Client", lastname: "Three", phone: "971503333333" });
  cdr("S3", { agent: B, start: at("10:10:00"), result: "busy", cause: "USER_BUSY", to: "0503333333" });
  // S4 logged by hand 11 minutes later -> already there
  contact("c4", { firstname: "Client", lastname: "Four", phone: "+971504444444" });
  hubCall({ hs_timestamp: new Date(at("11:30:00")).toISOString(), hs_call_body: "spoke about documents", hubspot_owner_id: "o3" }, ["c4"]);
  cdr("S4", { agent: B, start: at("11:19:05"), talk: 60, result: "answered", to: "+971504444444" });
  // S5 logged by hand 31 minutes later -> missing
  contact("c5", { firstname: "Client", lastname: "Five", phone: "+971505555555" });
  hubCall({ hs_timestamp: new Date(at("11:50:00")).toISOString(), hs_call_body: "", hubspot_owner_id: "o2" }, ["c5"]);
  cdr("S5", { agent: B, start: at("11:19:05"), talk: 45, result: "answered", to: "+971505555555" });
  // S6 logged 55 seconds before (clocks apart) -> already there; S7 65 seconds before -> missing
  contact("c6", { firstname: "Client", lastname: "Six", phone: "+971506666666" });
  hubCall({ hs_timestamp: new Date(at("11:18:10")).toISOString(), hs_call_body: "", hubspot_owner_id: "o3" }, ["c6"]);
  cdr("S6", { agent: C, start: at("11:19:05"), talk: 30, result: "answered", to: "+971506666666" });
  contact("c7", { firstname: "Client", lastname: "Seven", phone: "+971507777777" });
  hubCall({ hs_timestamp: new Date(at("11:18:00")).toISOString(), hs_call_body: "", hubspot_owner_id: "o3" }, ["c7"]);
  cdr("S7", { agent: C, start: at("11:19:05"), result: "cancel", to: "+971507777777" });
  // S8 the Ziwo app logged this very call
  const s8 = cdr("S8", { agent: A, start: at("12:00:00"), talk: 50, result: "answered", to: "+971501111111" });
  hubCall({ hs_timestamp: s8.startedAt, hs_call_body: `Call id : ${s8.callID}`, hs_call_to_number: "+971501111111", hubspot_owner_id: "o1",
    hs_call_disposition: "f240bbac-87c9-4f6e-bf70-924b57d47db7" }, ["c1"]);
  // S9 a number on no contact; S10 a consultant two HubSpot users share a name with
  cdr("S9", { agent: A, start: at("12:10:00"), talk: 15, result: "answered", to: "+971508888000" });
  cdr("S10", { agent: E, start: at("12:20:00"), talk: 15, result: "answered", to: "+971501111111" });
  // S11 incoming, answered; S12 incoming, missed; S13 internal
  contact("c9", { firstname: "Client", lastname: "Nine", mobilephone: "+971 50 999 9999" });
  cdr("S11", { agent: C, dir: "inbound", start: at("13:00:00"), talk: 60, result: "answered", from: "971509999999" });
  cdr("S12", { dir: "inbound", start: at("13:10:00"), result: "cancel", from: "971509999999" });
  cdr("S13", { agent: A, dir: "internal", start: at("13:20:00"), talk: 20, result: "answered", extra: { didCalled: "1012" } });
  // S14 the number is on two contacts, one of them the consultant's own (saved without country code)
  contact("c10", { firstname: "Dup", lastname: "Ten", phone: "+971502020202", hubspot_owner_id: "o1", notes_last_contacted: "2026-11-16T10:00:00Z" });
  contact("c11", { firstname: "Dup", lastname: "Eleven", phone: "0502020202", hubspot_owner_id: "o2", notes_last_contacted: "2026-10-01T10:00:00Z" });
  cdr("S14", { agent: B, start: at("14:00:00"), result: "busy", cause: "USER_BUSY", to: "+971502020202" });
  // S15 two contacts, neither the consultant's: the one worked on most recently
  contact("c12", { firstname: "Dup", lastname: "Twelve", phone: "+971503030303", hubspot_owner_id: "o3", notes_last_contacted: "2026-11-10T10:00:00Z" });
  contact("c13", { firstname: "Dup", lastname: "Thirteen", mobilephone: "971503030303", hubspot_owner_id: "o2", notes_last_contacted: "2026-11-16T10:00:00Z" });
  cdr("S15", { agent: A, start: at("14:10:00"), talk: 200, result: "answered", to: "+971503030303" });
  // S16 Saudi number saved without its country code; Danish is known only from the Ziwo app
  contact("c14", { firstname: "Client", lastname: "Fourteen", phone: "0551752664" });
  cdr("S16", { agent: Dn, start: at("14:20:00"), talk: 30, result: "answered", to: "966551752664" });
  // S17 a Qatar number HubSpot's search confuses with a longer UAE one
  contact("c15", { firstname: "Not", lastname: "This", phone: "+971552679479" });
  cdr("S17", { agent: A, start: at("14:30:00"), talk: 30, result: "answered", to: "97455267947" });
  // S18 logged by hand on the deal only; S19 logged by hand to the number only
  deal("d16", false);
  contact("c16", { firstname: "Client", lastname: "Sixteen", phone: "+971504040404" }, ["d16"]);
  hubCall({ hs_timestamp: new Date(at("15:10:00")).toISOString(), hs_call_body: "Call with unknown contact", hubspot_owner_id: "o2" }, [], ["d16"]);
  cdr("S18", { agent: B, start: at("15:00:00"), talk: 30, result: "answered", to: "+971504040404" });
  contact("c17", { firstname: "Client", lastname: "Seventeen", phone: "+971505050505" });
  hubCall({ hs_timestamp: new Date(at("15:35:00")).toISOString(), hs_call_body: "", hs_call_to_number: "+971505050505", hubspot_owner_id: "o3" });
  cdr("S19", { agent: C, start: at("15:30:00"), talk: 30, result: "answered", to: "+971505050505" });
  // S20 answered for 5 seconds -> No answer
  cdr("S20", { agent: A, start: at("16:00:00"), talk: 5, result: "answered", to: "+971501111111" });
  // S21 a skipped Ziwo user; S22 no client number at all
  cdr("S21", { agent: F, start: at("16:10:00"), talk: 30, result: "answered", to: "+971501111111" });
  cdr("S22", { agent: A, start: at("16:20:00"), talk: 30, result: "answered" });
  // S23 one call that Ziwo returns in two parts
  contact("c18", { firstname: "Client", lastname: "Eighteen", phone: "+971501212121" });
  const s23 = cdr("S23", { agent: A, start: at("17:00:00"), talk: 30, result: "answered", to: "+971501212121" });
  W.cdrs.push({ ...s23, id: s23.id + 50000, agentId: undefined, agent: undefined, talkTime: 0 });
  // S24 just before midnight, logged by hand just after it
  contact("c19", { firstname: "Client", lastname: "Nineteen", phone: "+971506060606" });
  hubCall({ hs_timestamp: new Date(at("00:10:00", "2026-11-18")).toISOString(), hs_call_body: "", hubspot_owner_id: "o3" }, ["c19"]);
  cdr("S24", { agent: C, start: at("23:55:00"), talk: 30, result: "answered", to: "+971506060606" });
  // calls on the days around, which must be left out
  cdr(null, { agent: A, start: at("23:50:00", "2026-11-16"), talk: 30, result: "answered", to: "+971501111111" });
  cdr(null, { agent: A, start: at("00:20:00", "2026-11-18"), talk: 30, result: "answered", to: "+971501111111" });

  // ---------------------------------------------------------------- pretend HubSpot search
  const calc = (v) => {
    const s = String(v || "").trim(); if (!s) return "";
    const d = s.replace(/\D/g, "");
    if (/^\+/.test(s) && !/[/|,;]|ext/i.test(s)) { const p = parsePhoneNumberFromString(s); return p ? p.nationalNumber : d; }
    return d.startsWith("00") ? d.slice(2) : d.startsWith("0") ? d.slice(1) : d;
  };
  const value = (props, name) => {
    if (name === "hs_searchable_calculated_phone_number") return calc(props.phone);
    if (name === "hs_searchable_calculated_mobile_number") return calc(props.mobilephone);
    return String(props[name] || "");
  };
  const passes = (props, f) => {
    const v = value(props, f.propertyName);
    if (f.operator === "HAS_PROPERTY") return v !== "";
    if (f.operator === "IN") return f.propertyName.startsWith("hs_searchable") ? f.values.some((x) => v && (v === x || v.startsWith(x))) : f.values.includes(v);
    if (f.operator === "EQ") return v === f.value;
    if (f.operator === "GTE") return Date.parse(props.hs_timestamp) >= Number(f.value);
    if (f.operator === "LT") return Date.parse(props.hs_timestamp) < Number(f.value);
    throw new Error(`pretend HubSpot has no ${f.operator}`);
  };
  const page = (list, body) => {
    const from = Number(body.after || 0), size = body.limit || 10;
    const slice = list.slice(from, from + size);
    return { total: list.length, results: slice, paging: from + size < list.length ? { next: { after: String(from + size) } } : undefined };
  };
  const reply = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => (obj === undefined ? "" : JSON.stringify(obj)), json: async () => obj });

  W.createdCall = (ziwoId) => W.created.find((c) => c.properties.hs_call_body.includes(ziwoId));
  function create(input) {
    if (!input.properties || !input.properties.hs_timestamp) return null;
    const id = String(W.next++);
    const contacts = [], deals = [];
    for (const a of input.associations || []) (a.types[0].associationTypeId === 194 ? contacts : deals).push(String(a.to.id));
    const rec = { id, properties: { ...input.properties }, contacts, deals };
    W.calls.set(id, rec); W.created.push(rec);
    W.createdIn[W.stage] = (W.createdIn[W.stage] || 0) + 1;
    return { id, properties: rec.properties, ...(W.noTrace ? {} : { objectWriteTraceId: input.objectWriteTraceId }) };
  }

  W.fetch = async (url, opts = {}) => {
    const u = new URL(url), method = (opts.method || "GET").toUpperCase();
    const body = opts.body && typeof opts.body === "string" && opts.body.startsWith("{") ? JSON.parse(opts.body) : opts.body;
    // ---- Ziwo
    if (u.hostname === "hof-api.aswat.co") {
      if (u.pathname === "/auth/login") {
        const p = new URLSearchParams(body);
        if (p.get("username") === "admin@hof" && p.get("password") === "pw") { W.logins++; return reply(200, { content: { access_token: "TOKEN-1" } }); }
        return reply(401, { error: "bad" });
      }
      if ((opts.headers || {}).access_token !== "TOKEN-1") return reply(401, { error: "token" });
      if (u.pathname === "/callHistory/listAgents") return reply(200, { content: W.agents });
      if (u.pathname === "/callHistory/") {
        const f = u.searchParams.get("fromDate"), t = u.searchParams.get("toDate");
        const limit = Number(u.searchParams.get("limit")), skip = Number(u.searchParams.get("skip"));
        const list = W.cdrs.filter((c) => (!f || c.startedAt.slice(0, 10) >= f) && (!t || c.startedAt.slice(0, 10) <= t))
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
        W.pagesRead++;
        return reply(200, { content: list.slice(skip, skip + limit), info: {}, result: true });
      }
      return reply(404, { error: u.pathname });
    }
    // ---- Resend
    if (u.hostname === "api.resend.com") { W.emails.push(JSON.parse(opts.body)); return reply(200, { id: "email" }); }
    // ---- HubSpot
    if (u.hostname !== "api.hubapi.com") throw new Error(`unexpected request to ${url}`);
    const p = u.pathname;
    if (p === "/crm/v3/owners") return reply(200, { results: W.owners });
    if (p === "/calling/v1/dispositions") return reply(200, [
      { id: "f240bbac-87c9-4f6e-bf70-924b57d47db7", label: "Connected" }, { id: "73a0d17f-1163-4015-bdd5-ec830791da20", label: "No answer" },
      { id: "9d9162e7-6cf3-4944-bf63-4dff82258764", label: "Busy" }, { id: "17b47fee-58de-441e-a44c-c6300d46f273", label: "Wrong number" }]);
    if (p === "/crm/v3/objects/calls/search") {
      const fs_ = body.filterGroups[0].filters;
      const list = [...W.calls.values()].filter((c) => fs_.every((f) => passes(c.properties, f)))
        .sort((a, b) => Date.parse(a.properties.hs_timestamp) - Date.parse(b.properties.hs_timestamp))
        .map((c) => ({ id: c.id, properties: c.properties }));
      return reply(200, page(list, body));
    }
    if (p === "/crm/v3/objects/contacts/search") {
      const list = [...W.contacts.entries()].filter(([, props]) => body.filterGroups.some((g) => g.filters.every((f) => passes(props, f))))
        .map(([id, props]) => ({ id, properties: props }));
      return reply(200, page(list, body));
    }
    const assoc = p.match(/^\/crm\/v4\/associations\/(\w+)\/(\w+)\/batch\/read$/);
    if (assoc) {
      const [, from, to] = assoc;
      const results = body.inputs.map(({ id }) => {
        let ids = [];
        if (from === "calls") { const c = W.calls.get(id); ids = c ? (to === "contacts" ? c.contacts : c.deals) : []; }
        if (from === "contacts" && to === "deals") ids = W.contactDeals.get(id) || [];
        return { from: { id }, to: ids.map((x) => ({ toObjectId: x })) };
      }).filter((r) => r.to.length);
      return reply(200, { results });
    }
    if (p === "/crm/v3/objects/deals/batch/read") return reply(200, { results: body.inputs.filter(({ id }) => W.deals.has(id)).map(({ id }) => ({ id, properties: W.deals.get(id) })) });
    if (p === "/crm/v3/objects/calls/batch/create") {
      if (W.failNext) { const s = W.failNext; W.failNext = 0; return reply(s, { message: "pretend failure" }); }
      return reply(201, { status: "COMPLETE", results: body.inputs.map(create) });
    }
    if (p === "/crm/v3/objects/calls" && method === "POST") return reply(201, create(body));
    if (p === "/oauth/v2/private-apps/get/access-token-info") return reply(200, { scopes: ["crm.objects.contacts.read", "crm.objects.contacts.write"] });
    return reply(404, { message: `pretend HubSpot has no ${method} ${p}` });
  };

  W.stage = "test";
  return W;
}

module.exports = { buildWorld };
