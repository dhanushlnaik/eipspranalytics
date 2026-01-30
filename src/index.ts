import path from "path";
import { createOctokit } from "./githubClient";
import { TARGET_REPOS, REPO_ORDER, BOT_LOGIN_SUFFIX } from "./config";
import { loadEditors } from "./editors";
import { extractAuthorsFromFiles } from "./authors";
import { buildTimeline } from "./events";
import { analyzeTimeline, categorizeResult, classifyPRType } from "./analysis";
import { writeCsv, mergeCsvFiles, CsvRow } from "./csv";

interface CliOptions {
  repoFilters: string[]; // if empty, use all target repos
  outputCsv: string;
}

function parseArgs(argv: string[]): CliOptions {
  const repoFilters: string[] = [];
  let outputCsv = "output/pr-analysis.csv";

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--repo" && i + 1 < argv.length) {
      repoFilters.push(argv[++i]);
    } else if (arg === "--csv" && i + 1 < argv.length) {
      outputCsv = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      // eslint-disable-next-line no-console
      console.log(
        [
          "Usage: node dist/index.js [--repo owner/name] [--csv path]",
          "",
          "If --repo is omitted, the default set is:",
          ...TARGET_REPOS.map((r) => `  - ${r}`),
        ].join("\n")
      );
      process.exit(0);
    }
  }

  return { repoFilters, outputCsv };
}

async function main() {
  const options = parseArgs(process.argv);
  const targetRepos =
    options.repoFilters.length > 0
      ? options.repoFilters
      : [...REPO_ORDER];

  const octokit = createOctokit();
  const editors = await loadEditors(octokit);

  const outputDir = path.dirname(options.outputCsv);
  const partialPaths: string[] = [];

  for (const fullName of targetRepos) {
    const [owner, repo] = fullName.split("/");
    if (!owner || !repo) {
      // eslint-disable-next-line no-console
      console.warn(`Skipping invalid repo identifier: ${fullName}`);
      continue;
    }

    // eslint-disable-next-line no-console
    console.log(`Analyzing open PRs for ${fullName}...`);

    const repoRows: CsvRow[] = [];
    const perPage = 50;
    let page = 1;

    while (true) {
      const { data: pulls } = await octokit.pulls.list({
        owner,
        repo,
        state: "open",
        per_page: perPage,
        page,
      });

      if (pulls.length === 0) break;

      for (const pr of pulls) {
        const prUrl = pr.html_url;
        const prTitle = pr.title;
        const createdAt = pr.created_at;
        const prNumber = pr.number;
        const prAuthorLogin = pr.user?.login ?? null;
        const headSha = pr.head.sha;
        const isDraft = pr.draft ?? false;
        const isCreatedByBot =
          prAuthorLogin !== null && prAuthorLogin.endsWith(BOT_LOGIN_SUFFIX);

        const now = new Date();
        const created = new Date(createdAt);
        const daysOpen =
          (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);

        // Fetch full PR details to get diff stats (additions/deletions/changed_files)
        const { data: prDetails } = await octokit.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        });

        // Get file changes for PR classification
        const fileChanges: Array<{
          filename: string;
          status: string;
          additions?: number;
          deletions?: number;
        }> = [];
        {
          const perPage = 100;
          let page = 1;
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
        }

        // Heuristic: small PRs with "typo" or grammar-related hints in the title.
        const isTypoLike =
          /typo|grammar|spelling/i.test(prTitle) &&
          (prDetails.changed_files ?? 0) <= 5 &&
          ((prDetails.additions ?? 0) + (prDetails.deletions ?? 0)) < 50;

        // Check if title suggests status change
        const isStatusChangeLike =
          /status|move|withdraw|finalize|supersede/i.test(prTitle);

        // Classify PR type (prBody from description for Tooling first-word check)
        const prBody = prDetails.body ?? null;
        const classification = classifyPRType({
          isDraft,
          isTypoLike,
          fileChanges,
          prTitle,
          prBody,
        });

        // Override classification if title suggests status change and we have modified EIP files
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
                f.filename.match(/RIPS\/rip-\d+\.md/i))
          );
          if (hasModifiedEipFiles) {
            classification.type = "STATUS_CHANGE";
          }
        }

        // Set bot flag and whether opener is an EIP preamble author
        classification.isCreatedByBot = isCreatedByBot;

        // For drafts, we can skip timeline analysis (but still include in CSV)
        let analysis;
        let timeline: Awaited<ReturnType<typeof buildTimeline>> = [];
        let daysSinceLastActivity: number | null = null;

        if (!isDraft) {
          const authors = await extractAuthorsFromFiles({
            octokit,
            owner,
            repo,
            pullNumber: prNumber,
            headSha,
          });

          const openedByPreambleAuthor =
            prAuthorLogin !== null && authors.has(prAuthorLogin);
          classification.openedByPreambleAuthor = openedByPreambleAuthor;

          timeline = await buildTimeline({
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
            timeline.length > 0
              ? timeline[timeline.length - 1].timestamp
              : createdAt;

          const lastActivityDate = new Date(lastActivityTs);
          daysSinceLastActivity =
            (now.getTime() - lastActivityDate.getTime()) /
            (1000 * 60 * 60 * 24);
        } else {
          // For drafts, create a minimal analysis
          analysis = {
            needsEditorAttention: false,
            waitingSince: null,
            lastEditorAction: null,
            lastAuthorAction: null,
            reason: "This PR is in draft status.",
          };
          daysSinceLastActivity = daysOpen;
        }

        const categorized = categorizeResult({
          result: analysis,
          classification,
          daysSinceLastActivity,
          prTitle,
        });

        const waitingSinceTs =
          categorized.needsEditorAttention && !categorized.waitingSince
            ? createdAt
            : categorized.waitingSince;

        const waitingDays =
          waitingSinceTs != null
            ? (now.getTime() - new Date(waitingSinceTs).getTime()) /
              (1000 * 60 * 60 * 24)
            : null;

        const row: CsvRow = {
          repo: fullName,
          pr_number: prNumber,
          pr_url: prUrl,
          pr_title: prTitle,
          created_at: createdAt,
          days_open: Number(daysOpen.toFixed(2)),
          needs_editor_attention: categorized.needsEditorAttention,
          waiting_since: waitingSinceTs,
          waiting_days:
            waitingDays !== null ? Number(waitingDays.toFixed(2)) : null,
          primary_reason: categorized.reason,
          last_editor_action_date:
            categorized.lastEditorAction?.date ?? null,
          last_author_action_date:
            categorized.lastAuthorAction?.date ?? null,
          category: categorized.category,
          subcategory: categorized.subcategory,
        };

        repoRows.push(row);

        // Also output a JSON-line per PR to stdout for transparency.
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify(
            {
              repo: fullName,
              number: prNumber,
              url: prUrl,
              title: prTitle,
              analysis: categorized,
            },
            null,
            2
          )
        );
      }

      if (pulls.length < perPage) break;
      page += 1;
    }

    const slug = fullName.replace("/", "-");
    const partialPath = path.join(outputDir, `${slug}.csv`);
    writeCsv(repoRows, partialPath);
    partialPaths.push(partialPath);
    // eslint-disable-next-line no-console
    console.log(`Saved ${repoRows.length} PRs to ${partialPath}`);
  }

  mergeCsvFiles(partialPaths, options.outputCsv);
  // eslint-disable-next-line no-console
  console.log(`\nMerged ${partialPaths.length} repo(s) into ${options.outputCsv}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

