# PR Scheduler & Aggregation Design

For a short **before vs after** summary (how it was vs how it is now), see [BEFORE_AND_AFTER.md](./BEFORE_AND_AFTER.md).

## Run order (required)

**Always run in this order:**  
**1. Import → 2. Snapshots → 3. Charts**

| Step | Command | What it does |
|------|---------|--------------|
| 1 | `npm run mongo:import` | Fetch PRs from GitHub, write to `eipprs` / `ercprs` / `ripprs`. |
| 2 | `npm run mongo:snapshots` | Build one snapshot per month (open PRs at month end) → `open_*_pr_snapshots`. |
| 3 | `npm run mongo:charts` | Graph 1 from PRs; Graph 2/3 from snapshots → chart collections. |

**One-shot full sync:** `npm run mongo:sync` (runs 1 → 2 → 3).  
**Ongoing:** `npm run mongo:scheduler` runs the same sequence on an interval (default 2h).

---

## 1. Single source of truth

**PR collections are the source of truth** for “which PRs exist” and “what category/subcategory each PR has.”

| Layer | Collections | Role |
|-------|-------------|------|
| **Source of truth** | `eipprs`, `ercprs`, `ripprs` | One document per PR. Import writes `category`, `subcategory`, etc. |
| **Snapshots (Graph 2/3 + details)** | `open_pr_snapshots`, `open_erc_pr_snapshots`, `open_rip_pr_snapshots` | **One document per month per repo:** `{ month: "YYYY-MM", snapshotDate: "YYYY-MM-DD", prs: [...] }` with **full PR metadata**. Same source for Graph 2/3 counts and for details API (eipboards). |
| **Graph 1 (PR states)** | `eipsPRCharts`, `ercsPRCharts`, `ripsPRCharts`, `allPRCharts` | Counts per month: **Created**, **Merged**, **Closed**, **Open** (from PR collections). |
| **Graph 2 (Process / Participants)** | `eipsCategoryCharts`, `eipsSubcategoryCharts` (and ercs/rips/all) | **Built from snapshots:** aggregate each snapshot’s `prs[]` by `pr.category` / `pr.subcategory`. |
| **Graph 3 (Process × Participants)** | `eipsCategorySubcategoryCharts` (and ercs/rips/all) | **Built from snapshots:** aggregate each snapshot’s `prs[]` by `category|subcategory`. |

**Rule for eipboards and Graph 2/3 to match:** Use the **same snapshot** the details API uses. For each month, take the **latest snapshot document** for that month in `open_*_pr_snapshots` (e.g. sort by `snapshotDate` desc and take the first). Aggregate that snapshot’s `prs[]` by `pr.category` / `pr.subcategory` and write the counts into the chart collections. The details API returns that same snapshot’s `prs[]` (with metadata). So counts and metadata come from the same snapshot → numbers match.

---

### Graph 2 & 3: counts only, no metadata

**Graph 2 and Graph 3 aggregation collections store only counts** (monthYear, type, count). They do **not** store per-PR metadata (PR number, title, author, link, labels, dates, etc.).

| What you get from Graph 2/3 APIs | What you do **not** get |
|----------------------------------|--------------------------|
| `monthYear`, `type` (Process or Participants or Process\|Participants), `count` | PR #, title, author, prUrl, createdAt, labels, etc. |

So:

- **Charts and count-only tables:** Use Graph 2 / Graph 3 APIs. You get **numbers only** (monthYear, type, count). Those counts are **built from the same snapshot** the details API uses (see §1).
- **Tables with metadata** (one row per PR: #, PR #, Title, Author, Created, Wait Time, Labels, View PR): Use the **details API** (`GET /api/AnalyticsCharts/category-subcategory/[name]/details?month=YYYY-MM`). It should read from **snapshot collections** (`open_pr_snapshots`, etc.): for the requested month, take the **latest snapshot per month** (sort by `snapshotDate` desc, take first) and return that snapshot’s `prs[]` as rows (Process = `pr.category`, Participants = `pr.subcategory`). Counts then match Graph 2/3 because both use the same snapshot.

**Summary:** Graph 2/3 aggregation = numbers only (from snapshot). Metadata = details API (same snapshot’s `prs[]`). One source = snapshot per month.

---

## 2. Graph 1 — Unified open / closed / merged (and created)

**Graph 1** is the **PR state** view: per month, how many PRs were **Created**, **Merged**, **Closed**, and how many were **Open** at end of month.

| Type | Meaning |
|------|--------|
| **Created** | PRs **created** in that month (count in that month). |
| **Merged** | PRs **merged** in that month (count in that month). |
| **Closed** | PRs **closed (not merged)** in that month (count in that month). |
| **Open** | PRs still **open** at **end** of that month (cumulative). |

**Collections:** `eipsPRCharts`, `ercsPRCharts`, `ripsPRCharts`, `allPRCharts`

**Document shape:**

```ts
{
  _id: string;
  category: string;   // "eips" | "ercs" | "rips" | "all"
  monthYear: string;  // "YYYY-MM"
  type: string;       // "Created" | "Merged" | "Closed" | "Open"
  count: number;
}
```

**Data source:** All PRs in `eipprs` / `ercprs` / `ripprs`. No filter by open only; Created/Merged/Closed are monthly counts, Open is cumulative at month-end.

**API:** Graph 1 consumers read only from these collections. Example: `GET /api/AnalyticsCharts/graph1/[name]` returns `{ data: [ { monthYear, type, count }, ... ] }` for the chosen repo or “all”.

**pranalyti:** `src/mongo/charts-job.ts` implements this in `getPRStateCountsByMonthYear()` and writes to the `*PRCharts` collections. Run `npm run mongo:charts` after import so Graph 1 is populated.

---

## 3. Month definition (pick one and stick to it)

| Definition | Meaning | Used by |
|------------|--------|--------|
| **A. Snapshot month** | “PR was open at end of month M” → PR appears in snapshot for M. | Snapshot collections; legacy details. |
| **B. Activity month** | “PR had `createdAt` or `updatedAt` in month M.” | pranalyti **details** API and **board aggregation** (open PRs with activity in M). |

**Recommendation:** Use **activity month (B)** for the details API and for Graph 2/3 **open-PR** aggregations, so “month” is consistent: a PR is in month M if it had activity (created or updated) in M. Graph 1 does not use “activity month”; it uses **all** PRs and actual `createdAt` / `closedAt` / `mergedAt` for Created/Merged/Closed/Open.

Document the choice in this file and in the scheduler; keep it consistent across details API and Graph 2/3.

---

## 4. Graph 2 — Process-only and Participants-only (open PRs)

Used by **PrLabels** (Graph 2: Process or Participants). **Open PRs only**, per month (using your month definition).

**Counts only, no metadata.** Each document is one aggregated count (monthYear + type + count). For a **table with metadata** (PR #, title, author, link, etc.) use the **details API** (see §6).

**Category (Process) – collections:** `eipsCategoryCharts`, `ercsCategoryCharts`, `ripsCategoryCharts`, `allCategoryCharts`

```ts
{ category: string; monthYear: string; type: string; count: number; }
// type = Process: "PR DRAFT" | "Typo" | "New EIP" | "Website" | "EIP-1" | "Tooling" | "Status Change" | "Content Edit"
```

**Subcategory (Participants) – collections:** `eipsSubcategoryCharts`, `ercsSubcategoryCharts`, `ripsSubcategoryCharts`, `allSubcategoryCharts`

```ts
{ category: string; monthYear: string; type: string; count: number; }
// type = Participants: "Waiting on Editor" | "Waiting on Author" | "Stagnant" | "AWAITED" | "Uncategorized" (or "Awaited" | "Misc" if you normalize)
```

**pranalyti:** Uses **stored** `category` and `subcategory` from PR docs; empty subcategory → `"Uncategorized"`. Canonical values in code are `"New EIP"` and `"AWAITED"`; if your frontend expects `"NEW EIP"` / `"Awaited"`, normalize in the API or frontend (see §7).

---

## 5. Graph 3 — Process × Participants (open PRs)

Used by **CategorySubcategoryChart**. One document per (monthYear, Process, Participants).

**Counts only, no metadata.** Each document is one aggregated count (monthYear + type + count). For a **table with metadata** (PR #, title, author, link, etc.) use the **details API** (see §6).

**Collections:** `eipsCategorySubcategoryCharts`, `ercsCategorySubcategoryCharts`, `ripsCategorySubcategoryCharts`, `allCategorySubcategoryCharts`

```ts
{ category: string; monthYear: string; type: string; count: number; }
// type = "Process|Participants" e.g. "Typo|Waiting on Editor", "PR DRAFT|AWAITED"
```

**pranalyti:** `getCategorySubcategoryCountsByMonthYear()` builds `type` as `category + "|" + subcategory` from stored fields. Open PRs only; same month rule as Graph 2.

---

## 6. API design (Graph 1 + Graph 2 + Graph 3 + Boards)

| Consumer | API | Data source | Returns |
|----------|-----|-------------|--------|
| **Graph 1** (open/closed/merged) | `GET /api/AnalyticsCharts/graph1/[name]` | `*PRCharts` | **Counts only:** monthYear, type, count |
| **PrLabels** (Graph 2) | `GET /api/AnalyticsCharts/graph2/[name]?view=category\|subcategory` | `*CategoryCharts` / `*SubcategoryCharts` | **Counts only:** monthYear, type, count |
| **CategorySubcategoryChart** (Graph 3) | `GET /api/AnalyticsCharts/graph3/[name]` | `*CategorySubcategoryCharts` | **Counts only:** monthYear, type, count |
| **eipboards / details** (per-PR table) | `GET /api/AnalyticsCharts/category-subcategory/[name]/details?month=YYYY-MM` | Snapshot collections: **latest snapshot per month** for requested month | **Metadata:** that snapshot’s `prs[]` as rows (PR #, title, author, link, Process, Participants, labels, dates, etc.) |

- **Graph 1 / 2 / 3:** Read only from the aggregation collections. **Numbers only** — no per-PR metadata.
- **Details API:** Read from **snapshot collections** for the requested month: **latest snapshot per month** (e.g. `find({ month }).sort({ snapshotDate: -1 }).limit(1)`), return that snapshot’s `prs[]` as rows (Process = `pr.category`, Participants = `pr.subcategory`). Use this whenever you need a table with metadata; counts then match Graph 2/3.

---

## 7. Canonical Process and Participants values

Use a single set of strings everywhere you can:

**Process (category):**  
`PR DRAFT` | `Typo` | `New EIP` | `Website` | `EIP-1` | `Tooling` | `Status Change` | `Content Edit`

**Participants (subcategory):**  
`Waiting on Editor` | `Waiting on Author` | `Stagnant` | `AWAITED` | `Uncategorized` (or `Awaited` | `Misc` if you prefer)

**pranalyti** stores `"New EIP"` and `"AWAITED"` (and empty → `"Uncategorized"`). If your frontend or another doc uses `"NEW EIP"` / `"Awaited"` / `"Misc"`, either (a) normalize in the API response, or (b) normalize in the frontend so the board and Graph 2/3 all match.

---

## 8. Scheduler flow (pranalyti) — detailed

Order: **Import → Snapshots → Charts.** So eipboards and Graph 2/3 use the same snapshot and match.

1. **Import PRs** (`npm run mongo:import`)  
   Fetch all PRs from GitHub (EIPs, ERCs, RIPs). For open PRs, run analysis (timeline, classification) and set `category`, `subcategory`, `waitingSince`. Write to `eipprs` / `ercprs` / `ripprs`.

2. **Snapshots** (`npm run mongo:snapshots`)  
   For each repo (EIP, ERC, RIP), from the PR collection build **one snapshot document per month** (from first PR `createdAt` to current month):
   - **Month:** `YYYY-MM`.
   - **Open at end of month:** PRs with `createdAt <= monthEnd` and not closed/merged by `monthEnd`.
   - **Document:** `{ month, snapshotDate: last day of month "YYYY-MM-DD", prs: [ ...full PR docs... ] }`.  
   Write to `open_pr_snapshots`, `open_erc_pr_snapshots`, `open_rip_pr_snapshots`.  
   **Latest snapshot per month:** there is only one doc per month (snapshotDate = last day of that month). If you ever have multiple snapshots per month, use sort by `snapshotDate` desc and take the first for that month.

3. **Charts** (`npm run mongo:charts`)  
   - **Graph 1:** From **PR collections** (all PRs), compute per-month Created/Merged/Closed/Open → write `*PRCharts`.  
   - **Graph 2 / Graph 3:** From **snapshot collections** (same source as details API). For each repo, load all snapshot docs (one per month). For each snapshot, aggregate `prs[]` by `pr.category`, by `pr.subcategory`, and by `category|subcategory`. Write counts to `*CategoryCharts`, `*SubcategoryCharts`, `*CategorySubcategoryCharts`.  
   - **All:** Merge eips+ercs+rips into `all*` collections.  
   If no snapshots exist yet, the chart job falls back to PR-based aggregation for Graph 2/3 and logs that you should run `mongo:snapshots` first.

4. **Scheduler** (`npm run mongo:scheduler`)  
   Runs **import → snapshots → charts** on an interval (e.g. every 2 hours).  
   **Full sync:** `npm run mongo:sync` = import then snapshots then charts.

---

## 9. Why it might not be working — checklist

- [ ] **Env:** `OPENPRS_MONGODB_URI` and `OPENPRS_DATABASE` are set in `.env` and in the Next.js app so pranalyti and the API use the same DB.
- [ ] **Order:** Run **import → snapshots → charts**. If you run charts without snapshots, Graph 2/3 fall back to PR-based aggregation and may not match the details API if the details API uses snapshots.
- [ ] **Import run:** `npm run mongo:import` so `eipprs`/`ercprs`/`ripprs` have `category` and `subcategory` on each PR.
- [ ] **Snapshots run:** `npm run mongo:snapshots` so `open_pr_snapshots`, `open_erc_pr_snapshots`, `open_rip_pr_snapshots` have one doc per month with `prs[]` (full metadata).
- [ ] **Charts run:** `npm run mongo:charts` after snapshots so Graph 2/3 are built from snapshots (counts match details API).
- [ ] **Graph 1 API:** Reads from `*PRCharts` and returns `type: "Created" | "Merged" | "Closed" | "Open"` with `monthYear` and `count`.
- [ ] **Details API:** Reads from **snapshot collections** for the requested month: **latest snapshot per month** (e.g. `findOne({ month }).sort({ snapshotDate: -1 })`) and returns that snapshot’s `prs[]` as rows (Process = `pr.category`, Participants = `pr.subcategory`). Then eipboards and Graph 2/3 counts match.
- [ ] **Canonical values:** Process/Participants in snapshot `prs[]` and chart `type` match what the frontend expects (or frontend normalizes).

Once import → snapshots → charts have run and the details API uses the same snapshots, Graph 1 (open/closed/merged), Graph 2, Graph 3, and eipboards stay aligned.
