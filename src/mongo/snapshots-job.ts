/**
 * Snapshots job: build open-PR snapshots per month from PR collections.
 * One document per month per repo: { month, snapshotDate, prs: [...] } with full PR metadata.
 * Graph 2/3 chart job and details API use "latest snapshot per month" from these collections
 * so counts and metadata match.
 */
import mongoose from "mongoose";
import { MONGODB_URI, MONGODB_DATABASE } from "../config";
import { EIP_PR, ERC_PR, RIP_PR, EIP_SNAPSHOTS, ERC_SNAPSHOTS, RIP_SNAPSHOTS } from "./schema";

if (!MONGODB_URI || !MONGODB_DATABASE) {
  throw new Error("OPENPRS_MONGODB_URI and OPENPRS_DATABASE must be set in .env");
}

function getMonthYear(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Last day of month as YYYY-MM-DD (month 1-12). */
function monthEndDateStr(year: number, month: number): string {
  const lastDay = new Date(year, month, 0); // JS month 0-based; day 0 = last day of previous month
  const y = lastDay.getFullYear();
  const m = String(lastDay.getMonth() + 1).padStart(2, "0");
  const d = String(lastDay.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Open at end of month M: created before end of M and not closed/merged by end of M. */
function isOpenAtMonthEnd(
  pr: { createdAt: Date; closedAt?: Date | null; mergedAt?: Date | null },
  monthEnd: Date
): boolean {
  if (pr.createdAt > monthEnd) return false;
  if (pr.mergedAt && pr.mergedAt <= monthEnd) return false;
  if (pr.closedAt && pr.closedAt <= monthEnd) return false;
  return true;
}

async function runSnapshotsForRepo(
  PRModel: typeof EIP_PR,
  SnapModel: typeof EIP_SNAPSHOTS,
  specType: string
): Promise<void> {
  const prs = await PRModel.find({}).lean();
  if (prs.length === 0) {
    console.log(`[${specType}] No PRs, skipping snapshots.`);
    return;
  }

  const prsTyped = prs as Record<string, unknown>[];
  const firstDate = prsTyped.reduce((min, pr) => {
    const d = pr.createdAt ? new Date(pr.createdAt as Date) : new Date();
    return min.getTime() < d.getTime() ? min : d;
  }, new Date(prsTyped[0]?.createdAt as string));
  const now = new Date();
  const startYear = firstDate.getFullYear();
  const startMonth = firstDate.getMonth() + 1;
  const endYear = now.getFullYear();
  const endMonth = now.getMonth() + 1;

  const months: { year: number; month: number }[] = [];
  for (let y = startYear; y <= endYear; y++) {
    const mStart = y === startYear ? startMonth : 1;
    const mEnd = y === endYear ? endMonth : 12;
    for (let m = mStart; m <= mEnd; m++) months.push({ year: y, month: m });
  }

  await SnapModel.deleteMany({});
  let inserted = 0;
  for (const { year, month } of months) {
    const monthEnd = new Date(year, month, 0, 23, 59, 59, 999);
    const monthKey = `${year}-${String(month).padStart(2, "0")}`;
    const snapshotDateStr = monthEndDateStr(year, month);

    const openPrs = prsTyped.filter((pr) =>
      isOpenAtMonthEnd(
        {
          createdAt: pr.createdAt as Date,
          closedAt: pr.closedAt as Date | null,
          mergedAt: pr.mergedAt as Date | null,
        },
        monthEnd
      )
    );

    await SnapModel.create({
      month: monthKey,
      snapshotDate: snapshotDateStr,
      prs: openPrs,
    });
    inserted++;
  }
  console.log(`[${specType}] Snapshots: ${inserted} months (open_pr_snapshots).`);
}

export async function run(): Promise<void> {
  console.log("[START] Snapshots job: building open PR snapshots per month...");
  await mongoose.connect(MONGODB_URI!, { dbName: MONGODB_DATABASE });

  await runSnapshotsForRepo(EIP_PR, EIP_SNAPSHOTS, "EIP");
  await runSnapshotsForRepo(ERC_PR, ERC_SNAPSHOTS, "ERC");
  await runSnapshotsForRepo(RIP_PR, RIP_SNAPSHOTS, "RIP");

  await mongoose.connection.close();
  console.log("[END] Snapshots job complete. Use latest snapshot per month for Graph 2/3 and details API.");
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
