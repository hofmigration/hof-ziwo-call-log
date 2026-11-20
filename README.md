# Ziwo call log

Every morning at **08:47 Pakistan time**, this agent reads yesterday's Ziwo calls and checks
that each one is in HubSpot.

- **Already in HubSpot**: left alone.
- **Missing**: logged on the client, under the consultant who made the call, as
  **Connected**, **No answer** or **Busy**.

You then get one email with the totals, the consultants, and anything that needs you. Every
call and the reason for each decision are in the attached sheet.

It starts as a **dry run** and logs nothing until you switch it on.

---

## How it decides

### 1. Which consultant made the call (Ziwo user → HubSpot user)

Each Ziwo user is matched to a HubSpot user. The first rule that works is used:

1. **By hand** in `config.js` (`AGENT_OVERRIDES`). This always wins.
2. **The same email address.** A Ziwo username is normally the email the consultant signs in with.
3. **Learned from Ziwo itself.** The Ziwo app has already put this person's calls in HubSpot,
   and every one of them is under the same HubSpot user.
4. **The same name before the @.** For example, Ziwo `saadaman` = `saadaman@hofmigration.com`.
5. **The same first and last name**, but only if exactly one HubSpot user has that name. Two
   people called "Ali Raza" are never guessed between.

If nothing matches, that person's calls are **not logged**. The email names them so you can
add one line to `config.js`. The sheet's *Consultants* tab shows how each person was matched.

### 2. Who the client is (phone number → HubSpot contact)

The number from Ziwo is put in international form (+971…, +966…). A Ziwo number with no
country code is read as a UAE number.

The agent then looks for that number on every contact's **Phone number**, **Mobile phone
number**, **Mobile number** and **WhatsApp phone number**, however it was typed: +971…,
971… with no plus, 00971…, 050…, with spaces, or two numbers in one box. These are the same
checks as the phone-bill check.

| Found | Counts? |
|---|---|
| The same number | ✅ |
| The same local number saved without the country code (055… / 55…) | ✅ |
| The same digits under another country code | ❌ |
| A number that only starts the same way | ❌ |

- **The number is on several contacts (duplicates).** The call goes on the contact owned by the
  consultant who made the call. If none is theirs, it goes on the contact worked on most
  recently. All of the duplicates are checked for an existing call first.
- **No contact has the number.** The call is not logged. The number is listed on the *Not in
  HubSpot* tab.

### 3. Is the call already logged?

| Already in HubSpot when… | |
|---|---|
| HubSpot has a call with the **same Ziwo call id** | Calls the Ziwo app logs start with `Call id : <Ziwo call id>`, and so do this agent's |
| Someone logged **any call on that client** from **1 minute before** the Ziwo call started until **30 minutes after** | On their contact, on any of their deals, or to their number |

**Example:** a Ziwo call at **11:19**. A call logged between **11:18 and 11:49** means it is
already there, so the agent does not log it. If there is none, the agent logs it.

The 1 minute before is there because Ziwo's clock and HubSpot's can be a few seconds apart.
Set `WINDOW_BEFORE_MINUTES: 0` to start exactly at 11:19.

A HubSpot call that carries a Ziwo call id only counts for that exact call. So three dial
attempts with nothing logged become three calls. One call the consultant logged by hand
covers every attempt in the 30 minutes before it.

### 4. The outcome

| | When |
|---|---|
| **Connected** | the client answered and they talked for 10 seconds or more |
| **Busy** | Ziwo says the line was busy, or the client rejected the call |
| **No answer** | anything else: rang out, not picked up, switched off, hung up before anyone answered, or answered for under 10 seconds (Ziwo calls these "phantom calls") |

**Calls clients make to HOF** are logged only when a consultant answered. Missed incoming
calls and calls between colleagues are never logged.

### 5. How the call looks in HubSpot

- **Where:** on the client's contact and on any of their open deals, at the time the Ziwo call
  started, under the consultant who made it.
- **Title:** `Call with <client>`, the same as the Ziwo app's calls.
- **First line:** `Call id : <Ziwo call id>`.
- **Second line:** *Logged automatically from Ziwo by the call-log agent*.
- **Also filled in:** the outcome, the direction, the talk time and both numbers.

---

## Setting it up

1. Create a **new private** repo, for example `hof-ziwo-call-log`. It must be **private**,
   because the sheet has client names and numbers.
2. **Add file → Upload files.** Drop in all of these, then **Commit changes**:
   - `config.js`, `0-ziwo.js`, `1-hubspot.js`, `2-phone.js`, `3-people.js`, `4-decide.js`
   - `5-workbook.js`, `6-email.js`, `run.js`, `selftest.js`, `package.json`, `README.md`
3. **Add file → Create new file.** Name it `.github/workflows/ziwo-call-log.yml` (typing the
   slashes makes the folders), paste in everything from `ziwo-call-log.yml`, and choose
   **Commit changes**.
4. Go to **Settings → Secrets and variables → Actions → New repository secret** and add each
   of these:

| Secret | What to put in it |
|---|---|
| `ZIWO_INSTANCE` | The first part of the address you sign in to Ziwo at. For `hofmigration.ziwo.io`, type `hofmigration`. |
| `ZIWO_API_KEY` | Your Ziwo API key. |
| `ZIWO_USERNAME` and `ZIWO_PASSWORD` | Only needed if Ziwo refuses the key. Use an **admin or supervisor** Ziwo login, so everyone's calls are visible. |
| `HUBSPOT_TOKEN` | The same HOF token your other agents use. |
| `RESEND_KEY` | The same key your other reports send email with. |

Paste each key straight into its secret. Never paste a key in a chat or in a file.

## First run: a dry run

1. Go to **Actions → Ziwo call log → Run workflow**.
2. Leave mode on **dry-run** and the dates blank, then choose **Run workflow**.
3. Wait 2–5 minutes. An email arrives titled **[Dry run] Ziwo call log – …**.

Open the sheet and check these:

1. **Checks tab → "Client's number – outgoing calls"** should name a Ziwo field and say it was
   checked against calls the Ziwo app logged.
2. **Checks tab → "HubSpot permission to log calls"** should say **Yes**.
3. **Consultants tab:** for anyone marked **Not matched**, add a line in `config.js` under
   `AGENT_OVERRIDES`:
   `"their Ziwo username": "their.hubspot.email@hofmigration.com",`
4. **Calls tab:** pick 3–4 rows marked **Would log** and compare the client and the time with
   Ziwo.

If anything on the Checks tab looks wrong, send a screenshot of it.

## Going live

1. Choose **Run workflow** again, with mode **live** and the dates blank (yesterday). Open 2–3
   of the logged calls in HubSpot from the sheet's **Open** links.
2. In `config.js`, change `SCHEDULED_MODE: "dry-run"` to `SCHEDULED_MODE: "live"` and commit.
   From then on it runs every morning by itself.

**Earlier days:** run it by hand with a `from_date` and `to_date`, up to 31 days at a time.
Nothing is ever logged twice, so running a day again is safe.

## If a run stops

You get an email that says why, and the run shows red in GitHub.

| Message | What to do |
|---|---|
| *Ziwo refused the request… the ZIWO_API_KEY was not accepted* | Add `ZIWO_USERNAME` and `ZIWO_PASSWORD` for an admin or supervisor Ziwo login. |
| *That Ziwo account cannot read the call history* | Use an admin or supervisor login. |
| *HubSpot token is missing a permission* | In HubSpot, go to **Settings → Integrations → Private apps**, open the app, then **Scopes**. Tick the calls write permission (`crm.objects.calls.write`, or `crm.objects.contacts.write` on older apps) and choose **Commit changes**. The token stays the same. |
| *N calls could not be logged* | Run it again for that date. Calls already saved are recognised. |
| *Ziwo sent the same page twice* | Ziwo's paging changed. Send me the run's log. |

## Worth knowing

- **The Ziwo app already logs some calls.** It logs calls dialled from inside HubSpot. On
  17 November 2026 that was 260 of the 2,897 calls in HubSpot. It marks every unanswered call
  "Busy". This agent uses Ziwo's own result to tell **No answer** from **Busy**.
- **It runs before your other reports.** The 08:47 run finishes before the 11:00 consultant
  activity and CM email reports, so those reports count the calls it logs.
- **Today's calls wait.** If you run it for today, calls from the last 30 minutes are left for
  the next run, so a consultant who is still logging a call is not beaten to it.
- **Nothing else is changed.** It only adds missing calls. It never edits or deletes anything,
  in HubSpot or in Ziwo.
- **Every rule has a test.** The tests are in `selftest.js`, which runs before every run. They
  include a full pretend day: a dry run, a live run, and a second live run that must log
  nothing. If a rule breaks, nothing is logged that day.
