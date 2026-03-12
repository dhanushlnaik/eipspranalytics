import { Octokit } from "@octokit/rest";

export interface EthBotReviewSignal {
  found: boolean;
  needsEditorReview: boolean;
  mentionedReviewers: string[];
  mentionsOnlyEditors: boolean;
}

const ETH_BOT_LOGIN = "eth-bot";
const ETH_BOT_BOT_LOGIN = "eth-bot[bot]";
const HANDLE_REGEX = /@([A-Za-z0-9-]+)/g;
const REVIEW_REQUEST_REGEX = /^Requires\s+\d+\s+more\s+reviewers?\s+from\s+(.+)$/im;

export async function getEthBotReviewSignal(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  editors: Set<string>;
}): Promise<EthBotReviewSignal | null> {
  const { octokit, owner, repo, pullNumber, editors } = params;
  const normalizedEditors = new Set(Array.from(editors).map((editor) => editor.toLowerCase()));

  const comments: Awaited<ReturnType<Octokit["issues"]["listComments"]>>["data"] = [];
  const perPage = 100;
  let page = 1;

  while (true) {
    const { data } = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: pullNumber,
      per_page: perPage,
      page,
    });
    if (data.length === 0) break;
    comments.push(...data);
    if (data.length < perPage) break;
    page += 1;
  }

  const ethBotComment = comments.find((comment) => {
    const login = comment.user?.login?.toLowerCase();
    const body = comment.body ?? "";
    return (
      (login === ETH_BOT_LOGIN || login === ETH_BOT_BOT_LOGIN) &&
      REVIEW_REQUEST_REGEX.test(body)
    );
  });

  if (!ethBotComment) return null;

  const body = ethBotComment.body ?? "";
  const reviewMatch = REVIEW_REQUEST_REGEX.exec(body);
  if (!reviewMatch) return null;

  const reviewers = new Set<string>();
  let handleMatch: RegExpExecArray | null;
  while ((handleMatch = HANDLE_REGEX.exec(reviewMatch[1])) !== null) {
    reviewers.add(handleMatch[1]);
  }

  const mentionedReviewers = Array.from(reviewers);
  const mentionsOnlyEditors =
    mentionedReviewers.length > 0 &&
    mentionedReviewers.every((reviewer) =>
      normalizedEditors.has(reviewer.toLowerCase())
    );

  return {
    found: true,
    needsEditorReview: mentionsOnlyEditors,
    mentionedReviewers,
    mentionsOnlyEditors,
  };
}
