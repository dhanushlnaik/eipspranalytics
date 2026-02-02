/**
 * Drop-in replacement for your category-subcategory details API.
 *
 * Why use this instead of the snapshot-based handler:
 * - Graph 3 (and Graph 2) are built from PR collections (eipprs, ercprs, ripprs) with
 *   analysis-derived category/subcategory. Snapshot collections + label derivation
 *   can disagree with those charts.
 * - This handler reads from the same PR collections and uses stored category/subcategory,
 *   so the table matches the Graph 2/3 counts and uses the same Process/Participants logic.
 *
 * Data source: OPENPRS_MONGODB_URI / OPENPRS_DATABASE, collections:
 *   eipprs, ercprs, ripprs (same as pranalyti import + charts).
 *
 * Copy this file into your Next.js app (e.g. pages/api/AnalyticsCharts/category-subcategory/[name]/details.ts)
 * and keep the same query params + response shape so the frontend does not need to change.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import mongoose, { Schema, Connection } from "mongoose";

const MONGODB_URI = process.env.OPENPRS_MONGODB_URI || "";
const DB_NAME = process.env.OPENPRS_DATABASE || "prsdb";

const PR_COLLECTIONS: Record<string, string> = {
  eips: "eipprs",
  ercs: "ercprs",
  rips: "ripprs",
};

const REPO_LABELS: Record<string, string> = {
  eips: "EIP PRs",
  ercs: "ERC PRs",
  rips: "RIP PRs",
};

const GITHUB_REPOS: Record<string, string> = {
  eips: "ethereum/EIPs",
  ercs: "ethereum/ERCs",
  rips: "ethereum/RIPs",
};

interface PRDoc {
  prId?: number;
  number: number;
  title?: string;
  author?: string;
  prUrl?: string;
  state?: string;
  createdAt?: Date;
  updatedAt?: Date;
  closedAt?: Date;
  mergedAt?: Date;
  specType?: string;
  draft?: boolean;
  category?: string;
  subcategory?: string;
  githubLabels?: string[];
}

const prSchema = new Schema<PRDoc>(
  {
    prId: Number,
    number: Number,
    title: String,
    author: String,
    prUrl: String,
    state: String,
    createdAt: Date,
    updatedAt: Date,
    closedAt: Date,
    mergedAt: Date,
    specType: String,
    draft: Boolean,
    category: String,
    subcategory: String,
    githubLabels: [String],
  },
  { strict: false }
);

function inMonth(d: Date | null | undefined, year: number, month: number): boolean {
  if (!d) return false;
  const x = d instanceof Date ? d : new Date(d);
  return x.getFullYear() === year && x.getMonth() === month - 1;
}

async function getConn(): Promise<Connection> {
  const conn = mongoose.createConnection(MONGODB_URI, {
    dbName: DB_NAME,
    readPreference: "primary",
    readConcern: { level: "majority" },
    maxIdleTimeMS: 10000,
  });
  await new Promise<void>((resolve, reject) => {
    conn.once("open", () => resolve());
    conn.once("error", (err) => reject(err));
  });
  return conn;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const name = req.query.name as string;
  const month = typeof req.query.month === "string" ? req.query.month : "";

  if (!name || !["eips", "ercs", "rips", "all"].includes(name)) {
    return res.status(400).json({ error: "Invalid name. Use eips, ercs, rips, or all." });
  }
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: "Invalid month. Use YYYY-MM." });
  }

  try {
    const conn = await getConn();
    const [y, m] = month.split("-").map(Number);
    const monthLabel = new Date(y, m - 1, 1).toLocaleString("default", {
      month: "short",
      year: "numeric",
    });

    const repoKeys = name === "all" ? (["eips", "ercs", "rips"] as const) : ([name] as const);
    const rows: {
      MonthKey: string;
      Month: string;
      Repo: string;
      Process: string;
      Participants: string;
      PRNumber: number;
      PRId: number;
      PRLink: string;
      Title: string;
      Author: string;
      State: string;
      CreatedAt: string;
      ClosedAt: string;
      Labels: string;
      GitHubRepo: string;
    }[] = [];

    for (const repoKey of repoKeys) {
      const coll = PR_COLLECTIONS[repoKey];
      const modelName = `PR_${repoKey}`;
      const Model = conn.models[modelName] ?? conn.model<PRDoc>(modelName, prSchema, coll);

      // Same scope as pranalyti board aggregation: open PRs with createdAt or updatedAt in this month
      const prs = await Model.find({ state: "open" }).lean();
      const inScope = (prs as PRDoc[]).filter(
        (pr) => inMonth(pr.createdAt, y, m) || inMonth(pr.updatedAt, y, m)
      );

      const repoLabel = REPO_LABELS[repoKey];
      const githubRepo = GITHUB_REPOS[repoKey];

      for (const pr of inScope) {
        const processVal = pr.category ?? "Other";
        const participantsVal = pr.subcategory ?? "Uncategorized";
        const labels = Array.isArray(pr.githubLabels) ? pr.githubLabels : [];

        rows.push({
          MonthKey: month,
          Month: monthLabel,
          Repo: repoLabel,
          Process: processVal,
          Participants: participantsVal,
          PRNumber: pr.number ?? 0,
          PRId: pr.prId ?? pr.number ?? 0,
          PRLink: pr.prUrl ?? `https://github.com/${githubRepo}/pull/${pr.number}`,
          Title: (pr.title ?? "").replace(/"/g, '""'),
          Author: pr.author ?? "",
          State: pr.state ?? "open",
          CreatedAt: pr.createdAt ? new Date(pr.createdAt).toISOString() : "",
          ClosedAt: pr.closedAt ? new Date(pr.closedAt).toISOString() : "",
          Labels: labels.join("; "),
          GitHubRepo: githubRepo,
        });
      }
    }

    await conn.close();
    return res.status(200).json(rows);
  } catch (error) {
    console.error("[category-subcategory details from PR collections]", error);
    return res.status(500).json({
      error: "Failed to fetch PR details",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
