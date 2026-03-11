import { Octokit } from "@octokit/rest";

export interface HeadCheckState {
  hasBlockingChecks: boolean;
}

export async function getHeadCheckState(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  ref: string;
}): Promise<HeadCheckState> {
  const { octokit, owner, repo, ref } = params;

  let hasBlockingChecks = false;

  try {
    const { data } = await octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref,
    });

    if (data.state === "failure" || data.state === "pending") {
      hasBlockingChecks = true;
    }
  } catch {
    // Ignore status API failures and fall through to check runs.
  }

  try {
    const { data } = await octokit.checks.listForRef({
      owner,
      repo,
      ref,
      per_page: 100,
    });

    const hasIncompleteOrFailingRuns = data.check_runs.some((run) => {
      if (run.status !== "completed") return true;
      return run.conclusion !== "success" && run.conclusion !== "neutral" && run.conclusion !== "skipped";
    });

    if (hasIncompleteOrFailingRuns) {
      hasBlockingChecks = true;
    }
  } catch {
    // Ignore checks API failures; combined status may still be enough.
  }

  return { hasBlockingChecks };
}
