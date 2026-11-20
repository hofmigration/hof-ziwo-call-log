// 5-workbook.js — the attached sheet: every Ziwo call of the day and what happened to it,
// so the agent can be checked, not just trusted.
const ExcelJS = require("exceljs");
const { SETTINGS: S } = require("./config");
const { pretty } = require("./2-phone");
const { contactLink, callLink } = require("./1-hubspot");
const { hhmm, dayOf, mmss } = require("./4-decide");

const NAVY = "FF16205E", LINE = "FFE6E9F1", PANEL = "FFF7F9FC";
const GREEN = ["FFE9F6EE", "FF1E7A4D"], RED = ["FFFDECEA", "FFB42318"], AMBER = ["FFFFF5E8", "FF9A5B0C"], BLUE = ["FFEAF1FB", "FF1D4F91"], GREY = [PANEL, "FF5B6472"];
const TONE = { "Logged": GREEN, "Would log": GREEN, "Already in HubSpot": BLUE, "Not logged": RED, "Could not log": RED, "Skipped": GREY };
const thin = { style: "thin", color: { argb: LINE } };
const BOX = { top: thin, left: thin, bottom: thin, right: thin };
const FONT = { name: "Arial", size: 10 };

function title(ws, text, sub, width) {
  const last = ws.getColumn(width).letter;
  ws.mergeCells(`A1:${last}1`);
  Object.assign(ws.getCell("A1"), { value: text });
  ws.getCell("A1").font = { name: "Arial", bold: true, size: 14, color: { argb: "FFFFFFFF" } };
  ws.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  ws.getCell("A1").alignment = { vertical: "middle", indent: 1 };
  ws.getRow(1).height = 28;
  ws.mergeCells(`A2:${last}2`);
  ws.getCell("A2").value = sub;
  ws.getCell("A2").font = { name: "Arial", size: 10, color: { argb: "FF4A5262" } };
  ws.getCell("A2").alignment = { vertical: "middle", indent: 1, wrapText: true };
  ws.getRow(2).height = 30;
}

function table(ws, at, cols, rows, toneOf) {
  cols.forEach(([label, width], i) => {
    ws.getColumn(i + 1).width = width;
    const c = ws.getRow(at).getCell(i + 1);
    c.value = label;
    c.font = { name: "Arial", bold: true, size: 10, color: { argb: "FFFFFFFF" } };
    c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    c.alignment = { vertical: "middle", wrapText: true };
    c.border = BOX;
  });
  ws.getRow(at).height = 30;
  rows.forEach((vals, r) => {
    const row = ws.getRow(at + 1 + r);
    vals.forEach((v, i) => {
      const c = row.getCell(i + 1);
      c.value = v === undefined || v === null ? "" : v;
      c.font = v && v.hyperlink ? { ...FONT, color: { argb: "FF1F2F8F" }, underline: true } : FONT;
      c.border = BOX;
      c.alignment = { vertical: "top", wrapText: true };
    });
    const tone = toneOf && toneOf(r);
    if (tone) { const [bg, fg] = tone.colors; const c = row.getCell(tone.col); c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bg } }; c.font = { ...FONT, bold: true, color: { argb: fg } }; }
  });
  ws.views = [{ state: "frozen", ySplit: at, xSplit: 0 }];
  if (rows.length) ws.autoFilter = { from: { row: at, column: 1 }, to: { row: at + rows.length, column: cols.length } };
}

const link = (url, text) => (url ? { text, hyperlink: url } : "");

async function build(rep, file) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Ziwo call log";
  const dry = rep.mode !== "live";
  const span = rep.from === rep.to ? rep.dayLabel : `${rep.dayLabel} to ${rep.toLabel}`;

  // ---- Summary
  const s = wb.addWorksheet("Summary");
  title(s, `Ziwo calls checked against HubSpot - ${span}`, dry
    ? "DRY RUN - nothing was written to HubSpot. \"Would log\" shows exactly what a live run will log."
    : "Live run - the calls marked \"Logged\" are now in HubSpot.", 3);
  const k = rep.counts;
  const lines = [
    ["Calls in Ziwo", k.total],
    ["Already in HubSpot", k.already],
    ["   by the Ziwo app (same Ziwo call id)", k.byApp],
    ["   by a person (a call on the client within the 30 minutes)", k.byPeople],
    ["   by this agent on an earlier run", k.byUs],
    [dry ? "Would log" : "Logged now", k.logged],
    ["   Connected", k.Connected],
    ["   No answer", k["No answer"]],
    ["   Busy", k.Busy],
    ["Not logged", k.notLogged],
    ["   number not in HubSpot", k.notInHubspot],
    ["   consultant not matched to a HubSpot user", k.noOwner],
    ["   no client number or no consultant in Ziwo", k.noNumber],
    ["Could not log (HubSpot refused - see the Calls tab)", k.failed],
    ["Skipped (internal, missed incoming, or switched off)", k.skipped],
  ];
  table(s, 4, [["", 58], ["Calls", 12], ["", 4]], lines.map(([a, b]) => [a, b ?? 0, ""]));
  s.views = [];

  // ---- Calls
  const c = wb.addWorksheet("Calls");
  title(c, "Every Ziwo call and what happened to it", "Times are Dubai time. \"Open in HubSpot\" opens the logged call, or the call that was already there.", 15);
  const callCols = [["Day", 11], ["Time", 7], ["Consultant (Ziwo)", 22], ["HubSpot user", 20], ["Direction", 10], ["Client number", 18],
    ["Client in HubSpot", 24], ["Contacts with this number", 11], ["Ziwo result", 13], ["Talk time", 9], ["Outcome", 11],
    ["What happened", 17], ["Detail", 44], ["Open in HubSpot", 13], ["Ziwo call id", 38]];
  const rows = [...rep.rows].sort((a, b) => (a.consultant || "").localeCompare(b.consultant || "") || a.when - b.when);
  table(c, 4, callCols, rows.map((r) => [
    dayOf(r.when), hhmm(r.when), r.consultant, r.owner, r.call.direction, r.number ? pretty(r.number) : "",
    r.contactId ? link(contactLink(r.contactId), r.contactName) : (r.matches.length ? `${r.matches.length} contact(s)` : ""),
    r.matches.length || "", r.call.result || r.call.hangupCause, mmss(r.call.talk),
    ["Logged", "Would log", "Could not log"].includes(r.status) ? r.outcome : "",
    r.status, r.detail, r.hubspotCallId ? link(callLink(r.hubspotCallId), "Open") : "", r.call.id,
  ]), (i) => ({ col: 12, colors: TONE[rows[i].status] || GREY }));

  // ---- Not in HubSpot
  const n = wb.addWorksheet("Not in HubSpot");
  title(n, "Numbers called that are not on any HubSpot contact", "Checked on Phone number, Mobile phone number, Mobile number and WhatsApp phone number, in every format. These calls were not logged.", 6);
  const byNum = new Map();
  for (const r of rep.rows.filter((x) => x.detail === "Number not in HubSpot")) {
    if (!byNum.has(r.number)) byNum.set(r.number, { calls: 0, people: new Set(), first: r.when, last: r.when, talk: 0 });
    const g = byNum.get(r.number);
    g.calls++; g.people.add(r.consultant); g.first = Math.min(g.first, r.when); g.last = Math.max(g.last, r.when); g.talk += r.call.talk;
  }
  table(n, 4, [["Number", 20], ["Calls", 8], ["Consultants", 40], ["First call", 17], ["Last call", 17], ["Talk time", 10]],
    [...byNum.entries()].sort((a, b) => b[1].calls - a[1].calls).map(([num, g]) => [pretty(num), g.calls, [...g.people].join(", "),
      `${dayOf(g.first)} ${hhmm(g.first)}`, `${dayOf(g.last)} ${hhmm(g.last)}`, mmss(g.talk)]));

  // ---- Consultants
  const p = wb.addWorksheet("Consultants");
  title(p, "Ziwo users and the HubSpot user their calls go under", "Not matched = their calls are not logged. Add them to AGENT_OVERRIDES in config.js.", 11);
  table(p, 4, [["Ziwo user", 24], ["Ziwo username", 28], ["Ziwo id", 9], ["HubSpot user", 22], ["Matched by", 30], ["Note", 40],
    ["Ziwo calls", 9], ["Already in HubSpot", 10], [dry ? "Would log" : "Logged", 9], ["Not logged", 9], ["Skipped", 9]],
  rep.consultants.map((x) => [x.name, x.username, x.id, x.owner, x.how, x.note, x.calls, x.already, x.logged, x.notLogged, x.skipped]),
  (i) => (rep.consultants[i].owner ? null : { col: 4, colors: RED }));

  // ---- Checks
  const ch = wb.addWorksheet("Checks");
  title(ch, "Checks - read these after the first runs", "How the agent read Ziwo this time. If something here looks wrong, the setting to change is named.", 2);
  table(ch, 4, [["Check", 46], ["Result", 110]], rep.checks.map((x) => [x[0], x[1]]));
  ch.views = [];

  // ---- How it works
  const h = wb.addWorksheet("How it works");
  title(h, "How the Ziwo call log decides", "The same rules as config.js. Change them there.", 1);
  h.getColumn(1).width = 130;
  rep.rules.forEach((line, i) => {
    const cell = h.getCell(4 + i, 1);
    cell.value = line;
    cell.font = /^[A-Z][A-Za-z ,'-]+$/.test(line) && line.length < 40 ? { name: "Arial", bold: true, size: 11, color: { argb: NAVY } } : FONT;
    cell.alignment = { wrapText: true, vertical: "top" };
  });

  await wb.xlsx.writeFile(file);
  return file;
}

module.exports = { build };
