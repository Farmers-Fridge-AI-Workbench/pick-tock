# Pick Tock — Backlog

Reconciled from the June 2026 project brief and the July 2026 context doc.
Where the two disagreed, the July doc won.

---

## High

| Item | Notes |
|---|---|
| PDF version of the plan for leads reading on phone | Requested by fpatel, 6/26/2026 |
| Ops Update Slack widget — end-to-end test | Shipped but never test-sent. Needs `picktock_ops_update_webhook` pointed at a personal DM webhook first |

## Medium

| Item | Notes |
|---|---|
| Consolidate CPT Override into the Linehaul Schedule area | Same redundancy pattern as the Market/LH mapping cleanup |
| Mobile / iOS layout | Android Chrome works. iOS Safari untested — boss uses an iPhone |
| Planned vs. actual finish times | Feeds the Snowflake/Hex pipeline item |
| OT + Chicago Fair Work Week cost modeling | Lives in the labor panel |
| `undoDayPublish` guard — remaining half | The exhausted-history case is **already guarded** (`if (!history.length) throw`), and the client disables the button mid-call. Still open: the bottom entry having no volume, and no `LockService`, so two tabs or two admins can still race |

## Low

| Item | Notes |
|---|---|
| Cross-week paste | Every-Friday friction. Called low-medium in the July doc |
| Hex API integration | Direct pull vs. Google Sheet intermediary. Blocked on confirming the Hex plan tier |
| Estimated arrival time per market | |
| Snowflake / Hex pipeline | Planned vs. actual analysis |
| Allocation time cost calculator — MW slider | Revenue loss display when the slider moves earlier than 6:00 PM |
| Market delivery stop order display | e.g. DAL → San Antonio → Houston |
| Constraints sidebar rework | Number entry instead of slider |
| Colorblind-friendly palette toggle | Swap `--green` / `--amber` / `--red` CSS vars via a sidebar checkbox |

---

## Removed

Kept here so they don't quietly reappear:

- Logistics tab bundle — date filter + calendar view below the table *(7/20/2026)*
- Logistics tab live-link shipping log — Load# / Appt / Carrier *(7/20/2026)*
- Role-based admin *(7/20/2026)*
- Logistics tab "week of" linehaul dropdown *(7/20/2026)*
- Load numbers on the dashboard — was pending Pick Pack team input *(7/20/2026)*
- Audit tab UI — an in-app viewer for the audit log. Cut 8/19/2026; the
  Google Sheet is doing the job fine. Server-side logging stays as-is

## Intentionally disabled — not backlog

- **DP notify float** (`showSlackFloat` / `sendPublishSlackNotify`) —
  disabled on purpose via early-return/throw guards. Unrelated to the
  Ops Update widget. Don't re-enable without asking.

---

## Done — August 2026

- `appsscript.json` `executeAs` corrected to `USER_ACCESSING` — repo had
  `USER_DEPLOYING`, which would have broken all admin/approver checks and sent
  carrier emails from the wrong account on the next clasp push
- `HMS Chicago` added to `DEFAULT_LH_SCHEDULE` — it previously existed only in
  live Script Properties, so a properties reset would have dropped it from the
  schedule while the server kept generating HMS volume

## Done — July 2026

- Allocation start time recommendations
- Level Load ingestion from DP paste data
- Approved checkmarks on the Logistics tab
- Logistics tab 24hr time formatting — Rec. Arrival and Sched. Appt
- Holiday secret button — updates LH schedule and CPTs
- Break time override / adjust lever
- Paste Data Log rewrite — logs every row including zeros
- Level Load volume split — `levelLoadVol` field, "LL "-prefixed virtual truck
- HMS Chicago linehaul — MW group, Tues/Thurs only
- Approval persistence fix — `normEmail_()`, per-department authorization guard
- Mobile scrolling fix — `min-width:0` on `.panel` and `.topbar`
- `LOAD_TYPE` string match fix
- `insertBreakAtTime` fix for the genuine idle-gap case
