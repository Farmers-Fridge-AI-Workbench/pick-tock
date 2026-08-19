# Pick Tock ⏱️

Google Apps Script web app for nightly pick-pack shift planning at the Cicero
facility. Given a day's linehaul schedule, it determines the pick-pack sequence
so every truck's product is picked before its CPT.

**This is deployed and load-bearing.** Real planners use it every night.
Treat `main` as production. Part of the Opsicle 🧊 ecosystem.

Owner: Cori Blackburn. Co-admin: mfuoco@farmersfridge.com.

## Stack

- `Code.js` + `Index.html` + `appsscript.json`
- `DP Report.js` — Demand Planning weekly Slack report (note the space in the
  filename; it is not `DPReport.gs`)
- State persisted server-side in Script Properties
- Deployed via clasp; repo is `Farmers-Fridge-AI-Workbench/pick-tock`
- `Index.html` inline JS is written one-function-per-line with no spaces. Grep
  `^function name` to find things and expect multi-thousand-character lines.

## Non-negotiable constants

Flag immediately if a change would touch any of these:

- `setInterval(pollForChanges, 5000)` — 5000ms. Never 15000. Never revert.
- `ADMINS` array must always contain cori.blackburn@ and mfuoco@
- `appsscript.json` must stay `"executeAs": "USER_ACCESSING"`. Under
  `USER_DEPLOYING`, `Session.getActiveUser().getEmail()` returns the deployer
  instead of the visitor — that breaks every admin and approver check in
  `getCurrentUser`, and carrier emails send from the wrong account. The live GAS
  project is the source of truth for this file; git has been wrong before.
- **No mock `google.script.run` shim in `Index.html`.** A stub that fakes the
  server lets saves silently write nothing. Never add one, not even to test.
- `_applyZoomStyles()` re-applies CSS on every render — font size changes must
  be made in both the CSS and the zoom function
- Inline `style=` beats class CSS — fixes to inline-styled elements must
  themselves be inline
- `.modal-overlay` must default to `display:none` so inline overrides work
- `picktock_cpts` is a separate Script Property from `picktock_state` — CPT
  overrides read and write to their own key
- `seenMarkets` Set is required in **both** forecast fetch functions
  (`fetchForecastWeek` and `fetchAndPublishAllForecastWeeks`) or Detroit and
  other duplicate markets double-count
- `DEFAULT_LH_SCHEDULE` in code is the fallback for CPTs that may not survive
  redeploy via Script Properties alone
- `saveDayLevers` must include both `levers.break30` and `levers.break15`
- `publishWeek` skips days already marked `mode: 'actual'` when incoming mode is
  `forecast` — actuals protection, do not weaken
- Day publishes use `Object.assign({}, existing, overrides)`, not a whitelist,
  so notes/approvals/levers/future fields survive automatically
- `simulate` must keep returning `idealDep` on each result object.
  `renderTable` reads it back as `r.idealDep` for the ideal-departure column, so
  dropping it doesn't throw — it silently shows planners a garbage time.

## Working rules

- **No UI popups, ever.** No `ui.alert()`, no toasts, no
  `SpreadsheetApp.getUi().alert()`. `Logger.log` for all diagnostics.
- All date/time formatting via `Utilities.formatDate()` with an explicit
  timezone.
- Teal is the signal color for interactive cells.
- Week labels use a capital W: `W27-2026`, never `w27-2026`.
- Mobile-only layout changes go in media queries. Never structural or DOM
  changes unless the change is intended everywhere.
- Don't change anything outside what was asked. Spot a problem elsewhere → say
  so and ask. Don't fix it.
- No unrequested refactors.
- Scheduling logic is duplicated in three places: `Index.html`, a deliberate
  mirror in `Code.js`, and again in `DP Report.js`. A rules change needs all
  three.
- Cori's machine is Windows. Any command handed to her to run must be
  PowerShell-safe — chain with `;`, not `&&`.

## Execute before fixing

**Mandatory for any scheduling or simulation bug.** Do not hand-reason about the
scheduler — run it. Extract `simulate`/`runRaw` into a node script, feed it real
volumes and levers pulled from Script Properties, and print the segment table.

If a fix fails twice, stop and run it. Never guess a third time.

The June 2026 dual-break incident took 15+ failed deployments. Root cause was
`insertBreakAtTime` snapping to segment boundaries instead of splitting
mid-segment. It was instantly obvious the moment it was actually executed.

## Before shipping

Claude runs these on every change without being asked:

- `node --check Code.js`
- `node --check "DP Report.js"`
- Extract the inline `<script>` block from `Index.html` with node, then
  `node --check` the extracted file

Both files, every time, no exceptions. There is no `python`, `py`, or `python3`
on this machine — use node for the extraction.

## Deploy

Claude does steps 1–3. Step 4 is Cori's.

1. `clasp pull` into a scratch directory and diff against the repo — someone may
   have edited directly in the GAS editor. Never `clasp pull` over the working
   tree.
2. `clasp push` — "Pushed successfully — 4 files uploaded" means it worked.
3. Commit and push to GitHub. Straight to `main`, no branch, no PR.
4. **Cori deploys manually**: GAS → Deploy → Manage Deployments → pencil → New
   version → Deploy

Claude never does step 4. After step 2 the `/dev` URL is live immediately, but
`/exec` — what planners actually use — stays pinned to the old version until
Cori deploys.

Cori's habit is to push to GAS well before committing, so git often lags the
live app rather than leading it. Never claim a change is or isn't live without
checking via step 1.

Notes: LF/CRLF warnings from git are harmless. GAS caps at 200 *versions* (not
deployments) — clear them via Project History when approaching the limit.

## Permission debugging

- Check `executeAs` first. See the `USER_ACCESSING` entry under
  non-negotiables — it has been the culprit before.
- **Never suggest "Preview as Role."** It gives false positives and cannot
  simulate `getCurrentUser()` server-side.

## Known discrepancies — do not silently fix

- **Truck arrival is calculated two different ways.** The UI (Schedule tab) uses
  PP End − 1hr rounded up to the nearest 15 min. `pushDepartureTimes` in
  `Code.js` uses CPT − 1hr flat, no rounding. Intent is unconfirmed. Raise it
  before changing either.
- `undoDayPublish` rapid double-trigger can step actual → forecast → empty
  placeholder. Guard not yet implemented.
- `DP Report.js` builds the prior-week label with `padStart(2, '00')` where
  `'0'` was meant. Harmless by accident. Left alone.

## Working with Cori

Direct and fast-moving. Prefers concise A/B options over long explanations. Lead
with the answer or the code, explain after. One clarifying question at a time.
Own mistakes plainly. Ask before making unrequested improvements.

Verify against the actual file before claiming anything works — read it, run it,
diff it. Never assert from memory or inference. If a claim can't be checked, say
that instead of asserting it.
