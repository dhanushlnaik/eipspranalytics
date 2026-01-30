# MongoDB Collections API — Frontend Reference

Database name: from `.env` → `OPENPRS_DATABASE`.

All chart collections share the same **document shape**:

```ts
interface ChartDocument {
  _id: string;      // unique (e.g. "2024-06-Created-...")
  category: string; // "eips" | "ercs" | "rips" | "all"
  monthYear: string; // "YYYY-MM" (e.g. "2024-06")
  type: string;    // varies by graph (see below)
  count: number;
}
```

---

## Graph 1: PR state counts (all PRs)

**What it is:** Per month, counts of PRs **Created**, **Merged**, **Closed** in that month, and cumulative **Open** at end of month. Uses **all** PRs (open + closed + merged).

**Collections:**

| Collection       | Scope   | `category` |
|------------------|---------|------------|
| `eipsPRCharts`   | EIPs    | `"eips"`   |
| `ercsPRCharts`   | ERCs    | `"ercs"`   |
| `ripsPRCharts`   | RIPs    | `"rips"`   |
| `allPRCharts`    | Combined| `"all"`    |

**Document fields:**

- `type`: **`"Created"`** | **`"Merged"`** | **`"Closed"`** | **`"Open"`**
  - **Created** = PRs created in that month
  - **Merged** = PRs merged in that month
  - **Closed** = PRs closed (not merged) in that month
  - **Open** = PRs still open at end of that month (cumulative)

**Example query (e.g. last 12 months, EIPs):**

```js
db.eipsPRCharts.find(
  { category: "eips" },
  { _id: 1, monthYear: 1, type: 1, count: 1 }
).sort({ monthYear: -1 }).limit(48)  // 12 months × 4 types
```

**Frontend usage:** One series per `type` (Created, Merged, Closed, Open); x-axis = `monthYear`. For stacked/grouped bar: group by `monthYear`, bars = `type`, value = `count`.

---

## Graph 2a: Open PRs by category (open PRs only)

**What it is:** Per month, count of PRs that were **open at end of that month**, grouped by **category**. Categories come from our analysis (not GitHub labels).

**Collections:**

| Collection            | Scope   | `category` |
|-----------------------|---------|------------|
| `eipsCategoryCharts`   | EIPs    | `"eips"`   |
| `ercsCategoryCharts`   | ERCs    | `"ercs"`   |
| `ripsCategoryCharts`   | RIPs    | `"rips"`   |
| `allCategoryCharts`    | Combined| `"all"`    |

**Document fields:**

- `type`: category name. Possible values:
  - **`"PR DRAFT"`** — draft PRs
  - **`"Typo"`** — typo/grammar fixes
  - **`"New EIP"`** — new EIP/ERC/RIP
  - **`"Status Change"`** — status change PRs
  - **`"Website"`** — website changes
  - **`"Tooling"`** — CI/config/tooling
  - **`"EIP-1"`** — EIP-1 changes
  - **`"Other"`** — everything else

**Example query (last 12 months, EIPs):**

```js
db.eipsCategoryCharts.find(
  { category: "eips" }
).sort({ monthYear: -1, count: -1 })
```

**Frontend usage:** One series per category (`type`); x-axis = `monthYear`; value = `count`. Totals per month match Graph 1’s **Open** count for that month.

---

## Graph 2b: Open PRs by subcategory (open PRs only)

**What it is:** Same as Graph 2a but grouped by **subcategory** (waiting state).

**Collections:**

| Collection               | Scope   | `category` |
|--------------------------|---------|------------|
| `eipsSubcategoryCharts`  | EIPs    | `"eips"`   |
| `ercsSubcategoryCharts`  | ERCs    | `"ercs"`   |
| `ripsSubcategoryCharts`  | RIPs    | `"rips"`   |
| `allSubcategoryCharts`   | Combined| `"all"`    |

**Document fields:**

- `type`: subcategory name. Possible values:
  - **`"AWAITED"`** — draft, not stagnant
  - **`"Waiting on Editor"`** — needs editor action
  - **`"Waiting on Author"`** — needs author action
  - **`"Stagnant"`** — waiting on author and inactive ≥90 days
  - **`"Uncategorized"`** — no subcategory (e.g. closed/other)

**Example query:**

```js
db.eipsSubcategoryCharts.find(
  { category: "eips" }
).sort({ monthYear: -1, count: -1 })
```

**Frontend usage:** One series per subcategory; x-axis = `monthYear`; value = `count`. Totals per month match Graph 1 **Open** and Graph 2a category totals.

---

## Graph 3: Open PRs by category × subcategory (stacked, open PRs only)

**What it is:** Per month, open PRs grouped by **both** category and subcategory. `type` is a composite: **`"category|subcategory"`** (e.g. `"Typo|Waiting on Editor"`).

**Collections:**

| Collection                    | Scope   | `category` |
|------------------------------|---------|------------|
| `eipsCategorySubcategoryCharts` | EIPs  | `"eips"`   |
| `ercsCategorySubcategoryCharts` | ERCs  | `"ercs"`   |
| `ripsCategorySubcategoryCharts` | RIPs | `"rips"`   |
| `allCategorySubcategoryCharts`  | Combined | `"all"` |

**Document fields:**

- `type`: **`"<category>|<subcategory>"`**  
  Examples: `"PR DRAFT|AWAITED"`, `"Typo|Waiting on Editor"`, `"Other|Uncategorized"`.

**Example query:**

```js
db.eipsCategorySubcategoryCharts.find(
  { category: "eips" }
).sort({ monthYear: -1, count: -1 })
```

**Frontend usage:** Split `type` on `|` to get category and subcategory. Use for stacked bars: e.g. x-axis = `monthYear`, stacks = category, segments = subcategory (or vice versa). Sum of `count` per month = Graph 1 **Open** for that month.

---

## PR collections (raw PRs, optional for frontend)

If you need **per-PR data** (e.g. tables, filters):

| Collection | Contents |
|------------|----------|
| `eipprs`   | All EIP PRs (open + closed), with `category`, `subcategory` |
| `ercprs`   | All ERC PRs |
| `ripprs`   | All RIP PRs |

**PR document shape (relevant fields):**

```ts
{
  prId: number;
  number: number;
  title: string;
  author: string;
  prUrl: string;
  state: "open" | "closed";
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  mergedAt: Date | null;
  specType: "EIP" | "ERC" | "RIP";
  draft: boolean;
  category: string;   // same as Graph 2a type
  subcategory: string; // same as Graph 2b type
  waitingSince: Date | null; // when current "waiting" state started (for board wait time)
}
```

**Example — open EIP PRs waiting on editor:**

```js
db.eipprs.find(
  { state: "open", subcategory: "Waiting on Editor" },
  { number: 1, title: 1, author: 1, prUrl: 1, category: 1, subcategory: 1, createdAt: 1 }
).sort({ createdAt: 1 })
```

---

## Board API — Open PRs for EIP/ERC/RIP boards

**Purpose:** Real-time (sync-fresh) list of **open** PRs for boards: waiting on editor / author, main categories, wait time. No new collection — queries existing `eipprs` / `ercprs` / `ripprs`.

### Endpoint

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/boards/:spec` | Open PRs for `eips` \| `ercs` \| `rips` with optional filters |
| GET | `/api/boards` | Help: lists allowed `spec` and query params |

**Query parameters:**

| Param | Type | Description |
|-------|------|-------------|
| `subcategory` | string | Filter by subcategory, e.g. `Waiting on Editor`, `Waiting on Author`, `Stagnant`, `AWAITED`, `Uncategorized` |
| `category` | string | Filter by category, e.g. `Typo`, `PR DRAFT`, `New EIP`, `Status Change`, `Website`, `Tooling`, `EIP-1`, `Other` |
| `sort` | string | `waitTime` (default: longest waiting first) \| `created` (oldest first) |

**Example requests:**

```text
GET /api/boards/eips
GET /api/boards/eips?subcategory=Waiting%20on%20Editor
GET /api/boards/eips?subcategory=Waiting%20on%20Author
GET /api/boards/eips?category=Typo
GET /api/boards/eips?subcategory=Waiting%20on%20Editor&sort=waitTime
```

### Response: array of board rows

Each item matches the table columns: **#**, **PR #**, **Title**, **Created**, **Wait Time**, **Category**, **Subcategory**, **Labels**, **View PR**.

```ts
interface BoardRow {
  index: number;        // row # (1-based)
  number: number;       // PR number
  title: string;
  author: string;
  createdAt: string;    // ISO date
  waitTimeDays: number | null;  // days waiting (from waitingSince or updatedAt)
  category: string;
  subcategory: string;
  labels: string[];     // githubLabels
  prUrl: string;        // "View PR" link
  specType: string;     // "EIP" | "ERC" | "RIP"
}
```

**Wait time:** Uses `waitingSince` when set (from timeline analysis); otherwise `updatedAt`; otherwise `createdAt`. Frontend can display as “X days” or “X weeks”.

### Running the board API

```bash
npm run build
npm run api:boards
```

Server listens on `http://localhost:3000` (or `PORT` in `.env`). CORS allows `*` in dev; tighten in production.

### Using the service in your own backend

If you already have a Node backend, you can call the board service without running the standalone server:

```ts
import { getBoardRows } from "./api/board-service";
import { EIP_PR } from "./mongo/schema";

// After MongoDB connect:
const rows = await getBoardRows(EIP_PR, {
  subcategory: "Waiting on Editor",
  sort: "waitTime",
});
// rows is BoardRow[]
```

---

## Summary table

| Graph   | Collections (per-repo + all) | `type` meaning | Data scope     |
|---------|------------------------------|----------------|----------------|
| **1**   | eipsPRCharts, ercsPRCharts, ripsPRCharts, allPRCharts | Created / Merged / Closed / Open | All PRs        |
| **2a**  | eipsCategoryCharts, … , allCategoryCharts | Category name | Open PRs only  |
| **2b**  | eipsSubcategoryCharts, … , allSubcategoryCharts | Subcategory name | Open PRs only  |
| **3**   | eipsCategorySubcategoryCharts, … , allCategorySubcategoryCharts | `category\|subcategory` | Open PRs only  |

---

## REST/API usage

If your frontend talks to a backend (e.g. Node/Express), expose read-only routes that query these collections by `category` (eips/ercs/rips/all) and optional `monthYear` range, and return the chart document shape above. Use the same filters and sorts as in the example queries.
