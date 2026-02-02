# Before vs After: Scheduler & Aggregation

This doc summarizes how the MongoDB sync and chart/board data worked **before** vs **now**, so eipboards and Graph 2/3 counts stay aligned.

---

## Before

### Data flow

- **PR collections only:** `eipprs`, `ercprs`, `ripprs` held all PRs. Import wrote `category` and `subcategory`.
- **Graph 1:** Built from PR collections (all PRs) → Created/Merged/Closed/Open per month. Same as now.
- **Graph 2 & 3:** Built **directly from PR collections** by re-computing “open at end of month” in the charts job: for each month, filter PRs with `createdAt ≤ monthEnd` and not closed/merged by `monthEnd`, then aggregate by `category` / `subcategory`.
- **Details API (eipboards):** Typically read from **PR collections** and applied its own month filter (e.g. “activity in month” or “open at month end”). That logic could differ from the charts job.

### Problems

| Issue | Effect |
|-------|--------|
| **Two different sources** | Chart counts came from one pass over PRs in the charts job; details API did its own query. Slight differences in “open at month end” or month boundaries caused mismatches. |
| **No single snapshot** | There was no stored “open PRs as of month M” document. So you couldn’t guarantee “the list behind the chart bar” was the same as “the list in the details table.” |
| **Run order** | Often: import → charts. No snapshot step, so Graph 2/3 and details were both derived independently from PRs (and could diverge). |

Result: **Chart counts and board/details rows could disagree** (e.g. “12 in chart, 10 in table” or different category breakdowns).

---

## Now

### Data flow

- **PR collections:** Still the source of truth for “which PRs exist” and their `category` / `subcategory`. Import unchanged.
- **Snapshot collections (new):** `open_pr_snapshots`, `open_erc_pr_snapshots`, `open_rip_pr_snapshots`. One document per month per repo: `{ month: "YYYY-MM", snapshotDate: "YYYY-MM-DD", prs: [ ...full PR docs... ] }`. Each snapshot = open PRs at end of that month.
- **Graph 1:** Still from PR collections (all PRs). Unchanged.
- **Graph 2 & 3:** Built **from snapshot collections**. For each month we use the **latest snapshot** for that month (sort by `snapshotDate` desc, take first). We aggregate that snapshot’s `prs[]` by `pr.category` and `pr.subcategory` and write counts to the chart collections.
- **Details API (eipboards):** Should read from **snapshot collections** for the requested month: **latest snapshot per month** (e.g. `findOne({ month }).sort({ snapshotDate: -1 })`) and return that snapshot’s `prs[]` as the table rows.

### Improvements

| Change | Effect |
|--------|--------|
| **Single source for Graph 2/3 and details** | Chart counts and details table both use the **same snapshot document** per month. So the numbers match by construction. |
| **Explicit “latest snapshot per month”** | If there are multiple snapshots for a month, both charts and details use the same rule: latest by `snapshotDate`. |
| **Run order** | **1. Import → 2. Snapshots → 3. Charts.** Snapshots are written before charts run, so Graph 2/3 are always built from snapshots (no fallback to PR-based aggregation unless snapshots are missing). |

Result: **Chart counts and board/details rows match** because they come from the same snapshot.

---

## Summary table

| Aspect | Before | Now |
|--------|--------|-----|
| **Graph 1** | PR collections (all PRs) | Same |
| **Graph 2/3 source** | PR collections (open-at-month-end computed in charts job) | Snapshot collections (latest snapshot per month) |
| **Details API source** | PR collections (own month logic) | Snapshot collections (latest snapshot per month) |
| **Snapshot collections** | None | `open_*_pr_snapshots` (one doc per month, full `prs[]`) |
| **Run order** | Import → Charts | **Import → Snapshots → Charts** |
| **Counts vs details** | Could mismatch | Match (same snapshot) |

---

## What you need to do

1. **Run in order:** `mongo:import` → `mongo:snapshots` → `mongo:charts` (or use `mongo:sync` / `mongo:scheduler`).
2. **Details API:** Point it at snapshot collections for the requested month; return that snapshot’s `prs[]` so it aligns with Graph 2/3.

See [PR_SCHEDULER_AGGREGATION_DESIGN.md](./PR_SCHEDULER_AGGREGATION_DESIGN.md) for run order and full design.
