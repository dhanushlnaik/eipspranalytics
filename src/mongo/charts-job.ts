/**
 * Charts job: populate chart collections from PR collections.
 * Graph 1: PR state counts (Created/Merged/Closed/Open) — all PRs.
 * Graph 2: Open PRs by category; Open PRs by subcategory — strictly open PRs only, no GitHub labels.
 * Graph 3: Open PRs by category × subcategory (stacked) — strictly open PRs only.
 */
import mongoose from "mongoose";
import { MONGODB_URI, MONGODB_DATABASE } from "../config";
import {
  EIP_PR,
  ERC_PR,
  RIP_PR,
  EIP_SNAPSHOTS,
  ERC_SNAPSHOTS,
  RIP_SNAPSHOTS,
  EIPS_PR_CHARTS,
  ERCS_PR_CHARTS,
  RIPS_PR_CHARTS,
  ALL_PR_CHARTS,
  EIPS_CATEGORY_CHARTS,
  ERCS_CATEGORY_CHARTS,
  RIPS_CATEGORY_CHARTS,
  ALL_CATEGORY_CHARTS,
  EIPS_SUBCATEGORY_CHARTS,
  ERCS_SUBCATEGORY_CHARTS,
  RIPS_SUBCATEGORY_CHARTS,
  ALL_SUBCATEGORY_CHARTS,
  EIPS_CAT_SUB_CHARTS,
  ERCS_CAT_SUB_CHARTS,
  RIPS_CAT_SUB_CHARTS,
  ALL_CAT_SUB_CHARTS,
} from "./schema";

if (!MONGODB_URI || !MONGODB_DATABASE) {
  throw new Error("OPENPRS_MONGODB_URI and OPENPRS_DATABASE must be set in .env");
}

/** PR document shape from MongoDB (lean). */
interface PRDoc {
  createdAt: Date;
  closedAt?: Date | null;
  mergedAt?: Date | null;
  category?: string | null;
  subcategory?: string | null;
}

/** Chart row shape for merge. */
interface ChartRow {
  monthYear: string;
  type: string;
  count: number;
}

function getMonthYear(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Graph 1: PR state counts by month — all PRs. Created/Merged/Closed = counts in that month; Open = cumulative open at end of month. */
function getPRStateCountsByMonthYear(
  prs: { createdAt: Date; closedAt?: Date | null; mergedAt?: Date | null }[],
  specType: string
): { _id: string; category: string; monthYear: string; type: string; count: number }[] {
  const allMonths = new Set<string>();
  prs.forEach((pr) => {
    allMonths.add(getMonthYear(pr.createdAt));
    if (pr.closedAt) allMonths.add(getMonthYear(pr.closedAt));
    if (pr.mergedAt) allMonths.add(getMonthYear(pr.mergedAt));
  });
  const sortedMonths = Array.from(allMonths).sort();
  const category = specType.toLowerCase() + "s";
  const out: { _id: string; category: string; monthYear: string; type: string; count: number }[] = [];

  for (const monthYear of sortedMonths) {
    const [y, m] = monthYear.split("-").map(Number);
    const monthEnd = new Date(y, m, 0, 23, 59, 59, 999);
    const monthStart = new Date(y, m - 1, 1);

    let created = 0,
      merged = 0,
      closed = 0,
      open = 0;
    prs.forEach((pr) => {
      if (pr.createdAt >= monthStart && pr.createdAt <= monthEnd) created++;
      if (pr.mergedAt && pr.mergedAt >= monthStart && pr.mergedAt <= monthEnd) merged++;
      if (pr.closedAt && !pr.mergedAt && pr.closedAt >= monthStart && pr.closedAt <= monthEnd) closed++;
      if (pr.createdAt <= monthEnd) {
        const stillOpen =
          (!pr.mergedAt && !pr.closedAt) ||
          (pr.mergedAt && pr.mergedAt > monthEnd) ||
          (pr.closedAt && pr.closedAt > monthEnd);
        if (stillOpen) open++;
      }
    });

    const id = (t: string) => `${monthYear}-${t}-${Date.now()}-${Math.random()}`;
    out.push({ _id: id("created"), category, monthYear, type: "Created", count: created });
    out.push({ _id: id("merged"), category, monthYear, type: "Merged", count: merged });
    out.push({ _id: id("closed"), category, monthYear, type: "Closed", count: closed });
    out.push({ _id: id("open"), category, monthYear, type: "Open", count: open });
  }
  return out.sort((a, b) => b.monthYear.localeCompare(a.monthYear));
}

/** Resolve subcategory for chart: use stored value; empty → Uncategorized. */
function resolveSubcategory(pr: { subcategory?: string | null }): string {
  const s = pr.subcategory;
  return s != null && s !== "" ? s : "Uncategorized";
}

/** Snapshot doc: month + prs[] (same source as details API). */
interface SnapshotDoc {
  month: string;
  snapshotDate?: string;
  prs?: { category?: string | null; subcategory?: string | null }[];
}

/** For each month, keep only the latest snapshot (sort by snapshotDate desc, first per month). */
function latestSnapshotPerMonth(snapshots: SnapshotDoc[]): SnapshotDoc[] {
  const byMonth = new Map<string, SnapshotDoc>();
  const sorted = [...snapshots].sort((a, b) => {
    const da = a.snapshotDate ?? "";
    const db = b.snapshotDate ?? "";
    return db.localeCompare(da); // desc: latest first
  });
  for (const s of sorted) {
    if (!byMonth.has(s.month)) byMonth.set(s.month, s);
  }
  return Array.from(byMonth.values()).sort((a, b) => a.month.localeCompare(b.month));
}

const CAT_SUB_SEP = "|";

/** Graph 2/3 from snapshots: aggregate each snapshot's prs[] by category, subcategory, category|subcategory. */
function getCategoryCountsFromSnapshots(
  snapshots: SnapshotDoc[],
  specType: string
): { _id: string; category: string; monthYear: string; type: string; count: number }[] {
  const category = specType.toLowerCase() + "s";
  const out: { _id: string; category: string; monthYear: string; type: string; count: number }[] = [];
  for (const snap of snapshots) {
    const prs = snap.prs ?? [];
    const counts: Record<string, number> = {};
    for (const pr of prs) {
      const cat = pr.category ?? "Other";
      counts[cat] = (counts[cat] ?? 0) + 1;
    }
    Object.entries(counts).forEach(([type, count]) => {
      if (count > 0)
        out.push({
          _id: `${snap.month}-${type}-${Date.now()}-${Math.random()}`,
          category,
          monthYear: snap.month,
          type,
          count,
        });
    });
  }
  return out.sort((a, b) => {
    if (a.monthYear !== b.monthYear) return b.monthYear.localeCompare(a.monthYear);
    return b.count - a.count;
  });
}

function getSubcategoryCountsFromSnapshots(
  snapshots: SnapshotDoc[],
  specType: string
): { _id: string; category: string; monthYear: string; type: string; count: number }[] {
  const category = specType.toLowerCase() + "s";
  const out: { _id: string; category: string; monthYear: string; type: string; count: number }[] = [];
  for (const snap of snapshots) {
    const prs = snap.prs ?? [];
    const counts: Record<string, number> = {};
    for (const pr of prs) {
      const sub = resolveSubcategory(pr);
      counts[sub] = (counts[sub] ?? 0) + 1;
    }
    Object.entries(counts).forEach(([type, count]) => {
      if (count > 0)
        out.push({
          _id: `${snap.month}-${type}-${Date.now()}-${Math.random()}`,
          category,
          monthYear: snap.month,
          type,
          count,
        });
    });
  }
  return out.sort((a, b) => {
    if (a.monthYear !== b.monthYear) return b.monthYear.localeCompare(a.monthYear);
    return b.count - a.count;
  });
}

function getCategorySubcategoryCountsFromSnapshots(
  snapshots: SnapshotDoc[],
  specType: string
): { _id: string; category: string; monthYear: string; type: string; count: number }[] {
  const category = specType.toLowerCase() + "s";
  const out: { _id: string; category: string; monthYear: string; type: string; count: number }[] = [];
  for (const snap of snapshots) {
    const prs = snap.prs ?? [];
    const counts: Record<string, number> = {};
    for (const pr of prs) {
      const cat = pr.category ?? "Other";
      const sub = resolveSubcategory(pr);
      const key = `${cat}${CAT_SUB_SEP}${sub}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    Object.entries(counts).forEach(([type, count]) => {
      if (count > 0)
        out.push({
          _id: `${snap.month}-${type.replace(/\|/g, "-")}-${Date.now()}-${Math.random()}`,
          category,
          monthYear: snap.month,
          type,
          count,
        });
    });
  }
  return out.sort((a, b) => {
    if (a.monthYear !== b.monthYear) return b.monthYear.localeCompare(a.monthYear);
    return b.count - a.count;
  });
}

/** Graph 2 (category): Open PRs per month by category — open PRs only, no labels. */
function getCategoryCountsByMonthYear(
  prs: { createdAt: Date; closedAt?: Date | null; mergedAt?: Date | null; category?: string | null }[],
  specType: string
): { _id: string; category: string; monthYear: string; type: string; count: number }[] {
  const allMonths = new Set<string>();
  prs.forEach((pr) => {
    allMonths.add(getMonthYear(pr.createdAt));
    if (pr.closedAt) allMonths.add(getMonthYear(pr.closedAt));
    if (pr.mergedAt) allMonths.add(getMonthYear(pr.mergedAt));
  });
  const sortedMonths = Array.from(allMonths).sort();
  const category = specType.toLowerCase() + "s";
  const out: { _id: string; category: string; monthYear: string; type: string; count: number }[] = [];

  const catSet = new Set([
    "PR DRAFT",
    "Typo",
    "New EIP",
    "Status Change",
    "Website",
    "Tooling",
    "EIP-1",
    "Other",
  ]);
  prs.forEach((pr) => catSet.add(pr.category || "Other"));

  for (const monthYear of sortedMonths) {
    const [y, m] = monthYear.split("-").map(Number);
    const monthEnd = new Date(y, m, 0, 23, 59, 59, 999);
    const counts: Record<string, number> = {};
    catSet.forEach((c) => (counts[c] = 0));

    prs.forEach((pr) => {
      if (pr.createdAt > monthEnd) return;
      if (pr.closedAt && pr.closedAt <= monthEnd) return;
      if (pr.mergedAt && pr.mergedAt <= monthEnd) return;
      const cat = pr.category || "Other";
      counts[cat]++;
    });

    Object.entries(counts).forEach(([type, count]) => {
      if (count > 0)
        out.push({
          _id: `${monthYear}-${type}-${Date.now()}-${Math.random()}`,
          category,
          monthYear,
          type,
          count,
        });
    });
  }
  return out.sort((a, b) => {
    if (a.monthYear !== b.monthYear) return b.monthYear.localeCompare(a.monthYear);
    return b.count - a.count;
  });
}

/** Graph 2 (subcategory): Open PRs per month by subcategory — open PRs only. */
function getSubcategoryCountsByMonthYear(
  prs: { createdAt: Date; closedAt?: Date | null; mergedAt?: Date | null; subcategory?: string | null }[],
  specType: string
): { _id: string; category: string; monthYear: string; type: string; count: number }[] {
  const allMonths = new Set<string>();
  prs.forEach((pr) => {
    allMonths.add(getMonthYear(pr.createdAt));
    if (pr.closedAt) allMonths.add(getMonthYear(pr.closedAt));
    if (pr.mergedAt) allMonths.add(getMonthYear(pr.mergedAt));
  });
  const sortedMonths = Array.from(allMonths).sort();
  const category = specType.toLowerCase() + "s";
  const out: { _id: string; category: string; monthYear: string; type: string; count: number }[] = [];
  const subSet = new Set(["AWAITED", "Waiting on Editor", "Waiting on Author", "Stagnant", "Uncategorized"]);

  for (const monthYear of sortedMonths) {
    const [y, m] = monthYear.split("-").map(Number);
    const monthEnd = new Date(y, m, 0, 23, 59, 59, 999);
    const counts: Record<string, number> = {};
    subSet.forEach((s) => (counts[s] = 0));

    prs.forEach((pr) => {
      if (pr.createdAt > monthEnd) return;
      if (pr.closedAt && pr.closedAt <= monthEnd) return;
      if (pr.mergedAt && pr.mergedAt <= monthEnd) return;
      const sub = resolveSubcategory(pr);
      counts[sub]++;
    });

    Object.entries(counts).forEach(([type, count]) => {
      if (count > 0)
        out.push({
          _id: `${monthYear}-${type}-${Date.now()}-${Math.random()}`,
          category,
          monthYear,
          type,
          count,
        });
    });
  }
  return out.sort((a, b) => {
    if (a.monthYear !== b.monthYear) return b.monthYear.localeCompare(a.monthYear);
    return b.count - a.count;
  });
}

/** Graph 3: Open PRs per month by category × subcategory — open PRs only. */
function getCategorySubcategoryCountsByMonthYear(
  prs: {
    createdAt: Date;
    closedAt?: Date | null;
    mergedAt?: Date | null;
    category?: string | null;
    subcategory?: string | null;
  }[],
  specType: string
): { _id: string; category: string; monthYear: string; type: string; count: number }[] {
  const allMonths = new Set<string>();
  prs.forEach((pr) => {
    allMonths.add(getMonthYear(pr.createdAt));
    if (pr.closedAt) allMonths.add(getMonthYear(pr.closedAt));
    if (pr.mergedAt) allMonths.add(getMonthYear(pr.mergedAt));
  });
  const sortedMonths = Array.from(allMonths).sort();
  const category = specType.toLowerCase() + "s";
  const out: { _id: string; category: string; monthYear: string; type: string; count: number }[] = [];

  for (const monthYear of sortedMonths) {
    const [y, m] = monthYear.split("-").map(Number);
    const monthEnd = new Date(y, m, 0, 23, 59, 59, 999);
    const counts: Record<string, number> = {};

    prs.forEach((pr) => {
      if (pr.createdAt > monthEnd) return;
      if (pr.closedAt && pr.closedAt <= monthEnd) return;
      if (pr.mergedAt && pr.mergedAt <= monthEnd) return;
      const cat = pr.category || "Other";
      const sub = resolveSubcategory(pr);
      const key = `${cat}${CAT_SUB_SEP}${sub}`;
      counts[key] = (counts[key] || 0) + 1;
    });

    Object.entries(counts).forEach(([type, count]) => {
      if (count > 0)
        out.push({
          _id: `${monthYear}-${type.replace(/\|/g, "-")}-${Date.now()}-${Math.random()}`,
          category,
          monthYear,
          type,
          count,
        });
    });
  }
  return out.sort((a, b) => {
    if (a.monthYear !== b.monthYear) return b.monthYear.localeCompare(a.monthYear);
    return b.count - a.count;
  });
}

async function populateCharts(
  PRModel: typeof EIP_PR,
  ChartsPR: typeof EIPS_PR_CHARTS,
  ChartsCat: typeof EIPS_CATEGORY_CHARTS,
  ChartsSub: typeof EIPS_SUBCATEGORY_CHARTS,
  ChartsCatSub: typeof EIPS_CAT_SUB_CHARTS,
  specType: string,
  SnapModel?: typeof EIP_SNAPSHOTS
) {
  const prsRaw = await PRModel.find({}).lean();
  const prs = prsRaw as unknown as PRDoc[];
  if (prs.length === 0) {
    console.log(`[${specType}] No PRs, skipping charts.`);
    return;
  }

  const stateData = getPRStateCountsByMonthYear(prs, specType);
  await ChartsPR.deleteMany({});
  if (stateData.length > 0) await ChartsPR.insertMany(stateData);
  console.log(`[${specType}] Graph 1 (PR states): ${stateData.length} points`);

  let catData: { _id: string; category: string; monthYear: string; type: string; count: number }[];
  let subData: { _id: string; category: string; monthYear: string; type: string; count: number }[];
  let catSubData: { _id: string; category: string; monthYear: string; type: string; count: number }[];

  if (SnapModel) {
    const snapshotsRaw = await SnapModel.find({}).lean();
    const allSnapshots = snapshotsRaw as unknown as SnapshotDoc[];
    const snapshots = latestSnapshotPerMonth(allSnapshots);
    if (snapshots.length > 0) {
      catData = getCategoryCountsFromSnapshots(snapshots, specType);
      subData = getSubcategoryCountsFromSnapshots(snapshots, specType);
      catSubData = getCategorySubcategoryCountsFromSnapshots(snapshots, specType);
      console.log(`[${specType}] Graph 2/3 from latest snapshot per month (${snapshots.length} months) — matches details API`);
    } else {
      catData = getCategoryCountsByMonthYear(prs, specType);
      subData = getSubcategoryCountsByMonthYear(prs, specType);
      catSubData = getCategorySubcategoryCountsByMonthYear(prs, specType);
      console.log(`[${specType}] Graph 2/3 from PRs (no snapshots yet; run mongo:snapshots first)`);
    }
  } else {
    catData = getCategoryCountsByMonthYear(prs, specType);
    subData = getSubcategoryCountsByMonthYear(prs, specType);
    catSubData = getCategorySubcategoryCountsByMonthYear(prs, specType);
  }

  await ChartsCat.deleteMany({});
  if (catData.length > 0) await ChartsCat.insertMany(catData);
  console.log(`[${specType}] Graph 2 (category): ${catData.length} points`);

  await ChartsSub.deleteMany({});
  if (subData.length > 0) await ChartsSub.insertMany(subData);
  console.log(`[${specType}] Graph 2 (subcategory): ${subData.length} points`);

  await ChartsCatSub.deleteMany({});
  if (catSubData.length > 0) await ChartsCatSub.insertMany(catSubData);
  console.log(`[${specType}] Graph 3 (category×subcategory): ${catSubData.length} points`);
}

async function populateAllCollections() {
  const [eips, ercs, rips] = await Promise.all([
    EIPS_PR_CHARTS.find({}).lean(),
    ERCS_PR_CHARTS.find({}).lean(),
    RIPS_PR_CHARTS.find({}).lean(),
  ]);

  const merge = (a: ChartRow[], b: ChartRow[], c: ChartRow[]) => {
    const map = new Map<string, number>();
    [...a, ...b, ...c].forEach((x) => {
      const k = `${x.monthYear}-${x.type}`;
      map.set(k, (map.get(k) || 0) + x.count);
    });
    return Array.from(map.entries()).map(([k, count]) => {
      // Key is "YYYY-MM-<type>"; monthYear is always 7 chars
      const monthYear = k.slice(0, 7);
      const type = k.length > 8 ? k.slice(8) : k;
      return {
        _id: `${k}-${Date.now()}-${Math.random()}`,
        category: "all",
        monthYear,
        type: type || k,
        count,
      };
    });
  };

  await ALL_PR_CHARTS.deleteMany({});
  const allState = merge(
    eips as unknown as ChartRow[],
    ercs as unknown as ChartRow[],
    rips as unknown as ChartRow[]
  );
  if (allState.length > 0) await ALL_PR_CHARTS.insertMany(allState);

  const [eipCat, ercCat, ripCat] = await Promise.all([
    EIPS_CATEGORY_CHARTS.find({}).lean(),
    ERCS_CATEGORY_CHARTS.find({}).lean(),
    RIPS_CATEGORY_CHARTS.find({}).lean(),
  ]);
  await ALL_CATEGORY_CHARTS.deleteMany({});
  const allCat = merge(
    eipCat as unknown as ChartRow[],
    ercCat as unknown as ChartRow[],
    ripCat as unknown as ChartRow[]
  );
  if (allCat.length > 0) await ALL_CATEGORY_CHARTS.insertMany(allCat);

  const [eipSub, ercSub, ripSub] = await Promise.all([
    EIPS_SUBCATEGORY_CHARTS.find({}).lean(),
    ERCS_SUBCATEGORY_CHARTS.find({}).lean(),
    RIPS_SUBCATEGORY_CHARTS.find({}).lean(),
  ]);
  await ALL_SUBCATEGORY_CHARTS.deleteMany({});
  const allSub = merge(
    eipSub as unknown as ChartRow[],
    ercSub as unknown as ChartRow[],
    ripSub as unknown as ChartRow[]
  );
  if (allSub.length > 0) await ALL_SUBCATEGORY_CHARTS.insertMany(allSub);

  const [eipCS, ercCS, ripCS] = await Promise.all([
    EIPS_CAT_SUB_CHARTS.find({}).lean(),
    ERCS_CAT_SUB_CHARTS.find({}).lean(),
    RIPS_CAT_SUB_CHARTS.find({}).lean(),
  ]);
  await ALL_CAT_SUB_CHARTS.deleteMany({});
  const allCS = merge(
    eipCS as unknown as ChartRow[],
    ercCS as unknown as ChartRow[],
    ripCS as unknown as ChartRow[]
  );
  if (allCS.length > 0) await ALL_CAT_SUB_CHARTS.insertMany(allCS);

  console.log("[ALL] Combined collections updated.");
}

export async function run(): Promise<void> {
  console.log("[START] Connecting to MongoDB...");
  await mongoose.connect(MONGODB_URI!, { dbName: MONGODB_DATABASE });

  console.log("\n=== Graph 1: PR state counts (all PRs) ===");
  console.log("=== Graph 2/3: from snapshots when present (same source as details API) ===");
  await Promise.all([
    populateCharts(
      EIP_PR,
      EIPS_PR_CHARTS,
      EIPS_CATEGORY_CHARTS,
      EIPS_SUBCATEGORY_CHARTS,
      EIPS_CAT_SUB_CHARTS,
      "EIP",
      EIP_SNAPSHOTS
    ),
    populateCharts(
      ERC_PR,
      ERCS_PR_CHARTS,
      ERCS_CATEGORY_CHARTS,
      ERCS_SUBCATEGORY_CHARTS,
      ERCS_CAT_SUB_CHARTS,
      "ERC",
      ERC_SNAPSHOTS
    ),
    populateCharts(
      RIP_PR,
      RIPS_PR_CHARTS,
      RIPS_CATEGORY_CHARTS,
      RIPS_SUBCATEGORY_CHARTS,
      RIPS_CAT_SUB_CHARTS,
      "RIP",
      RIP_SNAPSHOTS
    ),
  ]);

  console.log("\n=== Combined (all) collections ===");
  await populateAllCollections();

  await mongoose.connection.close();
  console.log("\n[END] Charts job complete. Graph 2 & 3 use open PRs only; category/subcategory from analysis (no GitHub labels).");
}

function main(): void {
  run().catch((e) => {
    console.error("[ERROR]", e);
    process.exit(1);
  });
}

if (typeof require !== "undefined" && require.main === module) {
  main();
}
