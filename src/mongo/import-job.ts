/**
 * MongoDB import job: fetch all PRs (open + closed) from GitHub,
 * enrich open PRs with category/subcategory from our analysis (no GitHub labels).
 * Closed PRs get category Other (or PR DRAFT if draft), subcategory empty.
 */
import { Octokit } from "@octokit/rest";
import { createOctokit } from "../githubClient";
import { REPO_ORDER, BOT_LOGIN_SUFFIX, MONGODB_URI, MONGODB_DATABASE } from "../config";
import { loadEditors } from "../editors";
import { extractAuthorsFromFiles } from "../authors";
import { buildTimeline } from "../events";
import { analyzeTimeline, categorizeResult, classifyPRType } from "../analysis";
import {
  EIP_PR,
  ERC_PR,
  RIP_PR,
} from "./schema";

if (!MONGODB_URI || !MONGODB_DATABASE) {
  throw new Error("OPENPRS_MONGODB_URI and OPENPRS_DATABASE must be set in .env");
}

const REPO_SPEC: Record<string, { owner: string; repo: string; specType: string; Model: typeof EIP_PR }> = {
  "ethereum/EIPs": { owner: "ethereum", repo: "EIPs", specType: "EIP", Model: EIP_PR },
  "ethereum/ERCs": { owner: "ethereum", repo: "ERCs", specType: "ERC", Model: ERC_PR },
  "ethereum/RIPs": { owner: "ethereum", repo: "RIPs", specType: "RIP", Model: RIP_PR },
};

const OPEN_PR_CONCURRENCY = 4;

function categoryForClosedPR(draft: boolean): { category: string; subcategory: string } {
  if (draft) return { category: "PR DRAFT", subcategory: "" };
  return { category: "Other", subcategory: "" };
}

/** Run async tasks with limited concurrency; small delay between batches to respect rate limits. */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number,
  delayMs = 150
): Promise<T[]> {
  const results: T[] = [];
  for (let i = 0; i < tasks.length; i += concurrency) {
    const batch = tasks.slice(i, i + concurrency);
    const batchResults = await Promise.all(batch.map((fn) => fn()));
    results.push(...batchResults);
    if (i + concurrency < tasks.length && delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return results;
}

async function enrichOpenPR(
  octokit: Octokit,
  editors: Set<string>,
  fullName: string,
  pr: Awaited<ReturnType<Octokit["pulls"]["list"]>>["data"][0],
  prDetails: Awaited<ReturnType<Octokit["pulls"]["get"]>>["data"]
): Promise<{ category: string; subcategory: string; waitingSince: Date | null }> {
  const prTitle = pr.title;
  const prNumber = pr.number;
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return { category: "Other", subcategory: "", waitingSince: null };

  const prAuthorLogin = pr.user?.login ?? null;
  const headSha = pr.head.sha;
  const isDraft = pr.draft ?? false;
  const createdAt = pr.created_at;

  const fileChanges: Array<{ filename: string; status: string; additions?: number; deletions?: number }> = [];
  let page = 1;
  const perPage = 100;
  while (true) {
    const { data } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: perPage,
      page,
    });
    if (data.length === 0) break;
    for (const f of data) {
      fileChanges.push({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      });
    }
    if (data.length < perPage) break;
    page += 1;
  }

  const isTypoLike =
    /typo|grammar|spelling/i.test(prTitle) &&
    (prDetails.changed_files ?? 0) <= 5 &&
    ((prDetails.additions ?? 0) + (prDetails.deletions ?? 0)) < 50;
  const isStatusChangeLike =
    /status|move|withdraw|finalize|supersede/i.test(prTitle);
  const prBody = prDetails.body ?? null;

  // Enrich fileChanges with a flag indicating whether a modified EIP/ERC/RIP file
  // changed only its preamble `status:` line (preamble-only change).
  const baseSha = prDetails.base?.sha ?? null;

  async function getFileContentAtRef(ref: string | null, filePath: string) {
    if (!ref) return null;
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref,
      });
      if (!("content" in data)) return null;
      const text = Buffer.from(data.content, "base64").toString("utf8");
      return text;
    } catch {
      return null;
    }
  }

  function splitPreambleAndBody(text: string) {
    const lines = text.split(/\r?\n/);
    let i = 0;
    for (; i < lines.length; i++) {
      if (lines[i].trim() === "") {
        break;
      }
    }
    const preamble = lines.slice(0, i).join("\n");
    const body = lines.slice(i + 1).join("\n");
    return { preamble, body };
  }

  function extractStatusFromPreamble(preamble: string): string | null {
    const re = /^status\s*:\s*(.+)$/im;
    const m = re.exec(preamble);
    if (!m) return null;
    return m[1].trim();
  }

  for (const f of fileChanges) {
    (f as any).preambleStatusChangedOnly = false;
  }

  for (const f of fileChanges) {
    if (
      f.status === "modified" &&
      (f.filename.match(/EIPS\/eip-\d+\.md/i) ||
        f.filename.match(/ERCS\/erc-\d+\.md/i) ||
        f.filename.match(/RIPS\/rip-\d+\.md/i))
    ) {
      const baseText = await getFileContentAtRef(baseSha, f.filename);
      const headText = await getFileContentAtRef(headSha, f.filename);
      if (baseText == null || headText == null) {
        (f as any).preambleStatusChangedOnly = false;
        continue;
      }
      const baseParts = splitPreambleAndBody(baseText);
      const headParts = splitPreambleAndBody(headText);
      if (baseParts.body !== headParts.body) {
        (f as any).preambleStatusChangedOnly = false;
        continue;
      }
      const baseStatus = extractStatusFromPreamble(baseParts.preamble);
      const headStatus = extractStatusFromPreamble(headParts.preamble);
      if (baseStatus == null && headStatus == null) {
        (f as any).preambleStatusChangedOnly = false;
        continue;
      }
      const stripStatus = (p: string) =>
        p
          .split(/\r?\n/)
          .filter((ln) => !/^status\s*:/i.test(ln))
          .join("\n")
          .trim();
      if (stripStatus(baseParts.preamble) === stripStatus(headParts.preamble) && baseStatus !== headStatus) {
        (f as any).preambleStatusChangedOnly = true;
      } else {
        (f as any).preambleStatusChangedOnly = false;
      }
    }
  }

  let classification = classifyPRType({
    isDraft,
    isTypoLike,
    fileChanges,
    prTitle,
    prBody,
  });
  if (
    !isDraft &&
    !isTypoLike &&
    classification.type === "OTHER" &&
    isStatusChangeLike
  ) {
    const hasModifiedEipFiles = fileChanges.some(
      (f) =>
        f.status === "modified" &&
        (f.filename.match(/EIPS\/eip-\d+\.md/i) ||
          f.filename.match(/ERCS\/erc-\d+\.md/i) ||
          f.filename.match(/RIPS\/rip-\d+\.md/i)) &&
        (f as any).preambleStatusChangedOnly === true
    );
    if (hasModifiedEipFiles) {
      classification.type = "STATUS_CHANGE";
    }
  }
  classification.isCreatedByBot =
    prAuthorLogin !== null && prAuthorLogin.endsWith(BOT_LOGIN_SUFFIX);

  let analysis: ReturnType<typeof analyzeTimeline>;
  let daysSinceLastActivity: number | null;

  if (!isDraft) {
    const authors = await extractAuthorsFromFiles({
      octokit,
      owner,
      repo,
      pullNumber: prNumber,
      headSha,
    });
    classification.openedByPreambleAuthor =
      prAuthorLogin !== null && authors.has(prAuthorLogin);

    const timeline = await buildTimeline({
      octokit,
      owner,
      repo,
      pullNumber: prNumber,
      editors,
      authors,
      prCreatedAt: createdAt,
      prAuthorLogin,
    });
    analysis = analyzeTimeline(timeline);
    const lastActivityTs =
      timeline.length > 0 ? timeline[timeline.length - 1].timestamp : createdAt;
    const now = new Date();
    daysSinceLastActivity =
      (now.getTime() - new Date(lastActivityTs).getTime()) /
      (1000 * 60 * 60 * 24);
  } else {
    analysis = {
      needsEditorAttention: false,
      waitingSince: null,
      lastEditorAction: null,
      lastAuthorAction: null,
      reason: "This PR is in draft status.",
    } as ReturnType<typeof analyzeTimeline>;
    const now = new Date();
    daysSinceLastActivity =
      (now.getTime() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
  }

  const categorized = categorizeResult({
    result: analysis,
    classification,
    daysSinceLastActivity,
    prTitle,
  });
  const waitingSince =
    analysis.waitingSince != null ? new Date(analysis.waitingSince) : null;
  return {
    category: categorized.category,
    subcategory: categorized.subcategory,
    waitingSince,
  };
}

async function runRepo(
  octokit: Octokit,
  editors: Set<string>,
  fullName: string,
  spec: { owner: string; repo: string; specType: string; Model: typeof EIP_PR }
) {
  const { owner, repo, specType, Model } = spec;
  const allPulls: Awaited<ReturnType<Octokit["pulls"]["list"]>>["data"] = [];
  let page = 1;
  const perPage = 50;

  console.log(`[${fullName}] Fetching all PRs (state=all)...`);
  while (true) {
    const { data: pulls } = await octokit.pulls.list({
      owner,
      repo,
      state: "all",
      per_page: perPage,
      page,
    });
    if (pulls.length === 0) break;
    allPulls.push(...pulls);
    if (pulls.length < perPage) break;
    page += 1;
  }
  console.log(`[${fullName}] Fetched ${allPulls.length} PRs total. Enriching open PRs (concurrency ${OPEN_PR_CONCURRENCY})...`);

  const docs: Record<string, unknown>[] = [];
  const openPrs: {
    pr: (typeof allPulls)[0];
    baseDoc: Record<string, unknown>;
  }[] = [];

  for (const pr of allPulls) {
    const state = pr.state;
    const isOpen = state === "open";

    const baseDoc = {
      prId: pr.id,
      number: pr.number,
      title: pr.title,
      author: pr.user?.login ?? "",
      prUrl: pr.html_url,
      githubLabels: (pr.labels as { name?: string }[] ?? []).map((l: { name?: string }) => l.name ?? ""),
      state,
      mergeable_state: (pr as { mergeable_state?: string }).mergeable_state ?? null,
      createdAt: pr.created_at ? new Date(pr.created_at) : null,
      updatedAt: pr.updated_at ? new Date(pr.updated_at) : null,
      closedAt: pr.closed_at ? new Date(pr.closed_at) : null,
      mergedAt: (pr as { merged_at?: string }).merged_at
        ? new Date((pr as { merged_at: string }).merged_at)
        : null,
      specType,
      draft: !!pr.draft,
    };

    if (!isOpen) {
      const { category, subcategory } = categoryForClosedPR(!!pr.draft);
      docs.push({ ...baseDoc, category, subcategory, waitingSince: null });
    } else {
      openPrs.push({ pr, baseDoc });
    }
  }

  const openTasks = openPrs.map(
    ({ pr, baseDoc }) =>
      async (): Promise<Record<string, unknown>> => {
        try {
          const { data: prDetails } = await octokit.pulls.get({
            owner,
            repo,
            pull_number: pr.number,
          });
          const { category, subcategory, waitingSince } = await enrichOpenPR(
            octokit,
            editors,
            fullName,
            pr,
            prDetails
          );
          return { ...baseDoc, category, subcategory, waitingSince };
        } catch (err) {
          console.warn(`[${fullName}] PR #${pr.number} enrich failed:`, (err as Error).message);
          const { category, subcategory } = categoryForClosedPR(!!pr.draft);
          return { ...baseDoc, category, subcategory, waitingSince: null };
        }
      }
  );
  const openDocs = await runWithConcurrency(openTasks, OPEN_PR_CONCURRENCY, 150);
  docs.push(...openDocs);

  console.log(`[${fullName}] Deleting old PRs...`);
  await Model.deleteMany({});
  if (docs.length > 0) {
    await Model.insertMany(docs);
    console.log(`[${fullName}] Inserted ${docs.length} PRs`);
  }
}

export async function run(): Promise<void> {
  const mongoose = await import("mongoose");
  console.log("[START] Connecting to MongoDB...");
  await mongoose.default.connect(MONGODB_URI!, { dbName: MONGODB_DATABASE });

  const octokit = createOctokit();
  const editors = await loadEditors(octokit);

  for (const fullName of REPO_ORDER) {
    const spec = REPO_SPEC[fullName];
    if (!spec) continue;
    await runRepo(octokit, editors, fullName, spec);
  }

  await mongoose.default.connection.close();
  console.log("[END] MongoDB import complete.");
}

function main() {
  return run().catch((e) => {
    console.error("[ERROR]", e);
    process.exit(1);
  });
}

if (require.main === module) {
  main();
}
