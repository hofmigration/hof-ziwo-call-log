// 6-email.js — the morning email. The numbers and what needs you are in the body; every
// call is in the attached sheet.
const { SETTINGS: S } = require("./config");

const C = { navy: "#16205e", ink: "#1f2937", body: "#3f4a5a", soft: "#868e9b", line: "#e6e9f1", panel: "#f7f9fc",
  good: "#1e7a4d", goodbg: "#e9f6ee", bad: "#b42318", badbg: "#fdecea", warn: "#9a5b0c", warnbg: "#fff5e8", blue: "#1d4f91", bluebg: "#eaf1fb" };
const F = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const n = (x) => Number(x || 0).toLocaleString("en-US");
const TH = `padding:7px 9px;font:700 10.5px/1.3 ${F};letter-spacing:.04em;text-transform:uppercase;color:${C.navy};background:${C.panel};border-bottom:1px solid ${C.line};text-align:left`;
const TD = `padding:8px 9px;border-top:1px solid ${C.line};font:400 12.5px/1.45 ${F};color:${C.ink};vertical-align:top`;

function stat(label, value, fg, bg) {
  return `<td width="25%" style="padding:4px"><div style="background:${bg};border-radius:6px;padding:12px 12px 10px">
<div style="font:700 24px/1.1 ${F};color:${fg}">${n(value)}</div>
<div style="font:600 11px/1.3 ${F};color:${C.body};margin-top:4px">${esc(label)}</div></div></td>`;
}

function buildEmail(rep) {
  const k = rep.counts, dry = rep.mode !== "live";
  const span = rep.from === rep.to ? rep.dayLabel : `${rep.dayLabel} to ${rep.toLabel}`;
  const banner = dry
    ? `<div style="background:${C.warnbg};border-left:4px solid ${C.warn};padding:10px 14px;margin:0 0 16px;font:600 13px/1.5 ${F};color:${C.warn}">DRY RUN - nothing was written to HubSpot. "Would log" is exactly what a live run will log.</div>`
    : "";
  const people = rep.consultants.filter((p) => p.calls).sort((a, b) => b.logged - a.logged || b.calls - a.calls);
  const peopleRows = people.map((p) => `<tr><td style="${TD}"><b>${esc(p.owner || p.name)}</b>${p.owner ? "" : p.skip ? ` <span style="color:${C.soft};font-size:11.5px">skipped in config.js</span>` : ` <span style="color:${C.bad};font-size:11.5px">not matched</span>`}</td>
<td style="${TD};text-align:right">${n(p.calls)}</td><td style="${TD};text-align:right">${n(p.already)}</td>
<td style="${TD};text-align:right;font-weight:700;color:${p.logged ? C.good : C.soft}">${n(p.logged)}</td>
<td style="${TD};text-align:right;color:${p.notLogged ? C.bad : C.soft}">${n(p.notLogged)}</td></tr>`).join("");

  const needs = [];
  const unmatched = rep.consultants.filter((p) => !p.owner && !p.skip && p.calls);
  if (unmatched.length) {
    needs.push(`<b>${unmatched.length} Ziwo user${unmatched.length > 1 ? "s are" : " is"} not matched to a HubSpot user</b>, so ${n(k.noOwner)} of their calls ${k.noOwner === 1 ? "was" : "were"} not logged: ${unmatched.map((p) => esc(p.name)).join(", ")}. Add them to AGENT_OVERRIDES in config.js.`);
  }
  if (k.notInHubspot) needs.push(`<b>${n(k.notInHubspotNumbers)} numbers called are not on any HubSpot contact</b> (${n(k.notInHubspot)} calls). They are on the "Not in HubSpot" tab.`);
  if (k.failed) needs.push(`<b>${n(k.failed)} calls could not be logged</b> - the reason is on the Calls tab. Running the agent again for ${esc(rep.from)} retries them; nothing is ever logged twice.`);
  for (const w of rep.warnings) needs.push(esc(w));

  const checks = rep.emailChecks.map((x) => `<li style="margin:0 0 5px">${esc(x)}</li>`).join("");

  return `<!doctype html><html><body style="margin:0;background:#eef1f6"><table width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f6"><tr><td align="center" style="padding:22px 10px">
<table width="680" cellpadding="0" cellspacing="0" style="max-width:680px;width:100%;background:#fff;border-radius:8px"><tr><td style="padding:24px 26px">
<div style="font:700 11px/1.4 ${F};letter-spacing:.08em;color:${C.soft};text-transform:uppercase">Ziwo call log</div>
<div style="font:700 21px/1.3 ${F};color:${C.navy};margin:2px 0 4px">Ziwo calls checked against HubSpot</div>
<div style="font:400 13px/1.5 ${F};color:${C.body};margin:0 0 16px">${esc(span)} (Dubai time)</div>
${banner}
<table width="100%" cellpadding="0" cellspacing="0"><tr>
${stat("Calls in Ziwo", k.total, C.navy, C.panel)}${stat("Already in HubSpot", k.already, C.blue, C.bluebg)}${stat(dry ? "Would log" : "Logged now", k.logged, C.good, C.goodbg)}${stat("Not logged", k.notLogged, C.bad, C.badbg)}
</tr></table>
<div style="font:400 13px/1.6 ${F};color:${C.body};margin:12px 4px 0">${dry ? "Would be logged" : "Logged"} as <b>Connected ${n(k.Connected)}</b> · <b>No answer ${n(k["No answer"])}</b> · <b>Busy ${n(k.Busy)}</b>. Already in HubSpot: ${n(k.byApp)} by the Ziwo app, ${n(k.byPeople)} logged by the consultant${k.byUs ? `, ${n(k.byUs)} by this agent earlier` : ""}.</div>
${needs.length ? `<div style="font:700 15px/1.3 ${F};color:${C.navy};margin:24px 0 8px">Needs you</div><ul style="margin:0;padding-left:18px;font:400 13px/1.55 ${F};color:${C.ink}">${needs.map((x) => `<li style="margin:0 0 7px">${x}</li>`).join("")}</ul>` : ""}
<div style="font:700 15px/1.3 ${F};color:${C.navy};margin:24px 0 8px">By consultant</div>
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid ${C.line};border-radius:6px">
<tr><th style="${TH}">Consultant</th><th style="${TH};text-align:right">Ziwo calls</th><th style="${TH};text-align:right">Already in HubSpot</th><th style="${TH};text-align:right">${dry ? "Would log" : "Logged"}</th><th style="${TH};text-align:right">Not logged</th></tr>
${peopleRows || `<tr><td colspan="5" style="${TD};color:${C.soft}">No Ziwo calls on this day.</td></tr>`}
</table>
${checks ? `<div style="font:700 15px/1.3 ${F};color:${C.navy};margin:24px 0 8px">Checks</div><ul style="margin:0;padding-left:18px;font:400 12.5px/1.5 ${F};color:${C.body}">${checks}</ul>` : ""}
<div style="border-top:1px solid ${C.line};margin-top:24px;padding-top:12px;font:400 11.5px/1.6 ${F};color:${C.soft}">
A Ziwo call counts as already logged when HubSpot has a call with the same Ziwo call id, or any call on that client (their contact, a deal, or their number) from ${S.WINDOW_BEFORE_MINUTES} minute before the Ziwo call started until ${S.WINDOW_AFTER_MINUTES} minutes after. Missing calls are logged on the client's contact and open deals, under the consultant who made the call. Connected = answered and talked ${S.CONNECTED_MIN_TALK_SECONDS} seconds or more. Every call and the reason for each decision are in the attached sheet.
</div></td></tr></table></td></tr></table></body></html>`;
}

async function sendEmail(subject, html, attachment) {
  if (!S.SEND_EMAIL) { console.log("Email switched off for this run."); return false; }
  if (!process.env.RESEND_KEY) { console.log("No RESEND_KEY secret - not emailed."); return false; }
  const body = { from: S.FROM_EMAIL, to: [S.REPORT_TO], subject, html };
  if (S.CC.length) body.cc = S.CC;
  if (attachment) body.attachments = [attachment];
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    console.log(`Email failed: ${res.status} ${(await res.text()).slice(0, 250)}`);
    if (res.status === 403) console.log("  The built-in sender (onboarding@resend.dev) only reaches the address the Resend account was registered with - CC needs a verified domain.");
    return false;
  }
  return true;
}

module.exports = { buildEmail, sendEmail };
