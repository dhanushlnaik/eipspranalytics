/**
 * Board API: open PRs for EIP/ERC/RIP boards (waiting on editor / author, categories, wait time).
 * No new collection — queries existing eipprs / ercprs / ripprs.
 */
import type { Model } from "mongoose";

export interface BoardFilters {
  subcategory?: string; // e.g. "Waiting on Editor", "Waiting on Author"
  category?: string;   // e.g. "Typo", "PR DRAFT"
  sort?: "waitTime" | "created"; // default: waitTime desc (longest waiting first)
}

export interface BoardRow {
  index: number;
  number: number;
  title: string;
  author: string;
  createdAt: string;   // ISO
  waitTimeDays: number | null;
  category: string;
  subcategory: string;
  labels: string[];    // githubLabels
  prUrl: string;
  specType: string;
}

/** One category or participant bucket in aggregation. */
export interface BoardAggregationBucket {
  name: string;       // category name or author (participant)
  count: number;
  prs: BoardRow[];
}

/** Aggregation for current month: open PRs grouped by category and by participant (author). */
export interface BoardAggregationResult {
  monthYear: string;  // "YYYY-MM"
  categories: BoardAggregationBucket[];
  participants: BoardAggregationBucket[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function computeWaitTimeDays(
  waitingSince: Date | null | undefined,
  updatedAt: Date | null | undefined,
  createdAt: Date | null | undefined
): number | null {
  const ref = waitingSince ?? updatedAt ?? createdAt;
  if (!ref) return null;
  const d = ref instanceof Date ? ref : new Date(ref);
  return (Date.now() - d.getTime()) / MS_PER_DAY;
}

export async function getBoardRows(
  PRModel: Model<unknown>,
  filters: BoardFilters = {}
): Promise<BoardRow[]> {
  const query: Record<string, unknown> = { state: "open" };
  if (filters.subcategory != null && filters.subcategory !== "")
    query.subcategory = filters.subcategory;
  if (filters.category != null && filters.category !== "")
    query.category = filters.category;

  const sortField = filters.sort === "created" ? "createdAt" : null;
  const prs = await PRModel.find(query)
    .sort(sortField ? { [sortField]: 1 } : {})
    .lean();

  if (filters.sort !== "created") {
    (prs as { waitingSince?: Date | null; updatedAt?: Date | null; createdAt?: Date }[]).sort(
      (a, b) => {
        const wa = computeWaitTimeDays(
          a.waitingSince ?? undefined,
          a.updatedAt ?? undefined,
          a.createdAt
        );
        const wb = computeWaitTimeDays(
          b.waitingSince ?? undefined,
          b.updatedAt ?? undefined,
          b.createdAt
        );
        const da = wa ?? -1;
        const db = wb ?? -1;
        return db - da; // longest waiting first
      }
    );
  }

  const rows: BoardRow[] = (prs as Record<string, unknown>[]).map((pr, i) => {
    const createdAt = pr.createdAt as Date | string;
    const waitTimeDays = computeWaitTimeDays(
      (pr.waitingSince as Date | null) ?? null,
      (pr.updatedAt as Date | null) ?? null,
      createdAt ? new Date(createdAt) : new Date(0)
    );
    return {
      index: i + 1,
      number: pr.number as number,
      title: (pr.title as string) ?? "",
      author: (pr.author as string) ?? "",
      createdAt: createdAt ? new Date(createdAt).toISOString() : "",
      waitTimeDays: waitTimeDays != null ? Math.round(waitTimeDays * 10) / 10 : null,
      category: (pr.category as string) ?? "Other",
      subcategory: (pr.subcategory as string) ?? "",
      labels: Array.isArray(pr.githubLabels) ? (pr.githubLabels as string[]) : [],
      prUrl: (pr.prUrl as string) ?? "",
      specType: (pr.specType as string) ?? "",
    };
  });

  return rows;
}

/** Build a single BoardRow from a lean PR doc. */
function prToBoardRow(pr: Record<string, unknown>, index: number): BoardRow {
  const createdAt = pr.createdAt as Date | string;
  const waitTimeDays = computeWaitTimeDays(
    (pr.waitingSince as Date | null) ?? null,
    (pr.updatedAt as Date | null) ?? null,
    createdAt ? new Date(createdAt) : new Date(0)
  );
  return {
    index,
    number: pr.number as number,
    title: (pr.title as string) ?? "",
    author: (pr.author as string) ?? "",
    createdAt: createdAt ? new Date(createdAt).toISOString() : "",
    waitTimeDays: waitTimeDays != null ? Math.round(waitTimeDays * 10) / 10 : null,
    category: (pr.category as string) ?? "Other",
    subcategory: (pr.subcategory as string) ?? "",
    labels: Array.isArray(pr.githubLabels) ? (pr.githubLabels as string[]) : [],
    prUrl: (pr.prUrl as string) ?? "",
    specType: (pr.specType as string) ?? "",
  };
}

/** Open PRs for the given month: createdAt or updatedAt in that month. */
function inMonth(d: Date | null | undefined, year: number, month: number): boolean {
  if (!d) return false;
  const x = d instanceof Date ? d : new Date(d);
  return x.getFullYear() === year && x.getMonth() === month - 1;
}

/**
 * Board aggregation for current month (or given monthYear): open PRs grouped by category
 * and by participant (author). Use this as the single source for boardsnew page.
 */
export async function getBoardAggregation(
  PRModel: Model<unknown>,
  monthYear?: string
): Promise<BoardAggregationResult> {
  const now = new Date();
  const y = monthYear ? parseInt(monthYear.slice(0, 4), 10) : now.getFullYear();
  const m = monthYear ? parseInt(monthYear.slice(5, 7), 10) : now.getMonth() + 1;
  const key = monthYear ?? `${y}-${String(m).padStart(2, "0")}`;

  const prs = await PRModel.find({ state: "open" }).lean();
  const inScope = (prs as Record<string, unknown>[]).filter((pr) => {
    const created = pr.createdAt as Date | undefined;
    const updated = pr.updatedAt as Date | undefined;
    return inMonth(created, y, m) || inMonth(updated, y, m);
  });

  const withWait = inScope as {
    waitingSince?: Date | null;
    updatedAt?: Date | null;
    createdAt?: Date | null;
    [k: string]: unknown;
  }[];
  withWait.sort((a, b) => {
    const wa = computeWaitTimeDays(a.waitingSince, a.updatedAt, a.createdAt);
    const wb = computeWaitTimeDays(b.waitingSince, b.updatedAt, b.createdAt);
    return (wb ?? -1) - (wa ?? -1);
  });

  const rows: BoardRow[] = withWait.map((pr, i) =>
    prToBoardRow(pr as Record<string, unknown>, i + 1)
  );

  const byCategory = new Map<string, BoardRow[]>();
  const byParticipant = new Map<string, BoardRow[]>();
  for (const row of rows) {
    const cat = row.category || "Other";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(row);
    const author = row.author || "(unknown)";
    if (!byParticipant.has(author)) byParticipant.set(author, []);
    byParticipant.get(author)!.push(row);
  }

  const categories: BoardAggregationBucket[] = Array.from(byCategory.entries()).map(
    ([name, prsInCat]) => ({ name, count: prsInCat.length, prs: prsInCat })
  );
  const participants: BoardAggregationBucket[] = Array.from(byParticipant.entries()).map(
    ([name, prsInPart]) => ({ name, count: prsInPart.length, prs: prsInPart })
  );

  return { monthYear: key, categories, participants };
}
