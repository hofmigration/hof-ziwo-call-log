// config.js — Ziwo call log. SAFE TO EDIT.
//
// Every morning this agent reads yesterday's calls from Ziwo and checks that each one is in
// HubSpot. A call that is already there is left alone. A call that is missing is logged on
// the client's record, under the consultant who made it, as Connected, No answer or Busy.
//
// Every rule is written out here in plain words. To change a rule, change it here — never
// quietly in the code. The same rules are printed on the "How it works" tab of every sheet.

const SETTINGS = {
  // ---- live or practice --------------------------------------------------------------
  // "dry-run"  logs nothing. The email shows every call it WOULD log. Start here.
  // "live"     logs the missing calls in HubSpot.
  // A run you start by hand asks you which. This setting is what the daily automatic run
  // does, so change it to "live" once a dry run looks right.
  SCHEDULED_MODE: "dry-run",

  // ---- days ----------------------------------------------------------------------------
  // A day is midnight to midnight, Dubai time (the main office). Each morning's run covers
  // the day before.
  TZ_OFFSET_HOURS: 4,

  // ---- THE RULE: is the call already in HubSpot? ----------------------------------------
  // 1. A HubSpot call with the same Ziwo call id is the same call. (Calls the Ziwo app puts
  //    in HubSpot start with "Call id : <Ziwo call id>", and so do the calls this agent
  //    logs.) Such a call only stands for its own Ziwo call.
  // 2. Any other call on the client — on their contact, on any of their deals, or to their
  //    number — logged from the minute the Ziwo call started until 30 minutes after it.
  //    Ziwo call at 11:19  ->  a call logged at 11:19 ... 11:49 means it is already there.
  //    One minute before (11:18) also counts, because Ziwo's clock and HubSpot's can be a
  //    few seconds apart. Set WINDOW_BEFORE_MINUTES to 0 to start exactly at 11:19.
  // Neither?  The call is missing, and gets logged.
  WINDOW_AFTER_MINUTES: 30,
  WINDOW_BEFORE_MINUTES: 1,

  // ---- the outcome ---------------------------------------------------------------------
  //   Connected  the client answered and they talked for 10 seconds or more
  //   Busy       Ziwo says the line was busy, or the client rejected the call
  //   No answer  everything else: rang out, not picked up, switched off, hung up before
  //              anyone answered, or answered for under 10 seconds (Ziwo itself calls those
  //              "phantom calls")
  CONNECTED_MIN_TALK_SECONDS: 10,
  BUSY_RESULTS: ["busy", "user_busy", "rejected", "call_rejected", "declined"],
  BUSY_HANGUP_CAUSES: ["USER_BUSY", "CALL_REJECTED"],

  // ---- which calls ---------------------------------------------------------------------
  LOG_OUTBOUND: true,        // calls the consultants make
  // Calls clients make to HOF:
  //   "answered"  logged when a consultant answered (as Connected, or No answer if it lasted
  //               under 10 seconds). A missed incoming call is not logged: "No answer"
  //               against someone who never had the chance to pick up would be wrong.
  //   "none"      incoming calls are never logged.
  LOG_INBOUND: "answered",

  // ---- consultants: Ziwo user -> HubSpot user --------------------------------------------
  // The call is logged under the consultant who made it. Each Ziwo user is matched to a
  // HubSpot user in this order, and the first that works is used:
  //   1. AGENT_OVERRIDES below, by hand. This wins over everything.
  //   2. Same email address. (A Ziwo username is normally the email they sign in with.)
  //   3. Learned from Ziwo itself: the Ziwo app has already logged this person's calls in
  //      HubSpot, and every one of them is under the same HubSpot user.
  //   4. Same name before the @  (Ziwo "saadaman"  =  saadaman@hofmigration.com).
  //   5. Same first and last name, but only if exactly one HubSpot user has that name.
  //      Two people with the same name are never guessed between.
  // Not matched?  Their calls are NOT logged, and the email names them so you can add a
  // line here. "skip" ignores a Ziwo user completely (a test or shared account).
  AGENT_OVERRIDES: {
    // "ziwo username, Ziwo user id or full name": "their.email@hofmigration.com",
    // "test.agent@hofmigration.com": "skip",
  },

  // ---- clients: phone number -> HubSpot contact ------------------------------------------
  // The number from Ziwo is put in international form (+971..., +966...). A Ziwo number with
  // no country code is read as a UAE number. It is then looked for on every contact's
  // Phone number, Mobile phone number, Mobile number and WhatsApp phone number, however it
  // was typed there: +971..., 971... (no plus), 00971..., 050..., with spaces or dashes,
  // or two numbers in one box ("+971... / +92...").
  //   The same number                                   ->  match
  //   Saved without the country code (055... / 55...)   ->  match (same local number)
  //   The same digits under another country code        ->  NOT a match
  //   Only the first digits the same                    ->  NOT a match
  // The same number on more than one contact (duplicates): the call goes on the contact
  // owned by the consultant who made the call; if none is theirs, on the contact that was
  // worked on most recently. All of them are checked for an existing call first.
  // No contact has the number?  Not logged, and listed in the email.
  DEFAULT_COUNTRY: "AE",
  // Which Ziwo field holds the client's number. "auto" works it out each run by checking
  // the fields against the calls the Ziwo app has already put in HubSpot. Set a field name
  // (for example "didCalled") only if the Checks tab shows "auto" getting it wrong.
  CLIENT_NUMBER_FIELD: "auto",
  // HOF's own numbers are never a client. Lines that appear on dozens of calls from
  // several consultants in a day are recognised automatically; add any it misses here.
  HOF_NUMBERS: [],

  // ---- how the call looks in HubSpot ---------------------------------------------------
  // Logged on the client's contact and on any of their deals that are still open. Title
  // "Call with <client>" and first line "Call id : <Ziwo call id>", exactly like the calls
  // the Ziwo app logs, so every Ziwo call in HubSpot can be found the same way. The second
  // line says this agent logged it.
  ASSOCIATE_OPEN_DEALS: true,
  // HubSpot's own call outcomes (the same ids your other agents use).
  DISPOSITIONS: {
    "Connected": "f240bbac-87c9-4f6e-bf70-924b57d47db7",
    "No answer": "73a0d17f-1163-4015-bdd5-ec830791da20",
    "Busy": "9d9162e7-6cf3-4944-bf63-4dff82258764",
  },

  // ---- the email -------------------------------------------------------------------------
  REPORT_TO: "razaali@hofmigration.com",
  CC: [],                                 // only after hofmigration.com is verified in Resend
  FROM_EMAIL: "onboarding@resend.dev",    // once verified, e.g. "compliance@hofmigration.com"
  SEND_EMAIL: String(process.env.SEND_EMAIL || "true").toLowerCase() !== "false",
  ROWS_IN_EMAIL: 25,                      // per list; every row is in the attached sheet

  // ---- plumbing ------------------------------------------------------------------------
  PORTAL_ID: "23735726",
  SEARCH_RPS: 4,             // HubSpot allows 5 searches a second for the whole account
  API_RPS: 8,
  ZIWO_PAGE_SIZE: 100,
  ZIWO_MAX_PAGES: 600,       // 60,000 Ziwo calls in one run is the most it will read
  MAX_DAYS_PER_RUN: 31,
  OUT_DIR: "out",
};

module.exports = { SETTINGS };
