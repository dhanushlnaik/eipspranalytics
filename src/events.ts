import { Octokit } from "@octokit/rest";
import { BOT_LOGIN_SUFFIX } from "./config";

export type ActorRole = "EDITOR" | "AUTHOR";

export type EventSource =
  | "PR_OPENED"
  | "COMMIT"
  | "ISSUE_COMMENT"
  | "REVIEW_COMMENT"
  | "REVIEW_APPROVED"
  | "REVIEW_CHANGES_REQUESTED"
  | "REVIEW_COMMENTED";

export interface TimelineEvent {
  actor: string;
  role: ActorRole;
  source: EventSource;
  timestamp: string; // ISO
}

function isBot(login: string | null | undefined): boolean {
  if (!login) return true;
  return login.endsWith(BOT_LOGIN_SUFFIX);
}

export async function buildTimeline(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  editors: Set<string>;
  authors: Set<string>;
  prCreatedAt: string;
  prAuthorLogin: string | null;
}): Promise<TimelineEvent[]> {
  const { octokit, owner, repo, pullNumber, editors, authors, prCreatedAt, prAuthorLogin } =
    params;

  const events: TimelineEvent[] = [];

  const normalizedEditors = new Set(
    Array.from(editors).map((e) => e.toLowerCase())
  );
  // PR opener always counts as AUTHOR for their commits/comments so we don't
  // misclassify when preamble has no author line or opener isn't in it.
  const effectiveAuthors = new Set(
    Array.from(authors).map((a) => a.toLowerCase())
  );
  if (prAuthorLogin && !isBot(prAuthorLogin)) {
    effectiveAuthors.add(prAuthorLogin.toLowerCase());
  }

  const classifyRole = (login: string | null | undefined): ActorRole | null => {
    if (!login) return null;
    const lower = login.toLowerCase();
    if (normalizedEditors.has(lower)) return "EDITOR";
    if (effectiveAuthors.has(lower)) return "AUTHOR";
    return null;
  };

  // PR opened event (treated as an author event if opener is an author).
  if (prAuthorLogin && !isBot(prAuthorLogin)) {
    const role = classifyRole(prAuthorLogin);
    if (role === "AUTHOR") {
      events.push({
        actor: prAuthorLogin,
        role,
        source: "PR_OPENED",
        timestamp: prCreatedAt,
      });
    }
  }

  // Reviews (editor events)
  const reviews: Awaited<
    ReturnType<typeof octokit.pulls.listReviews>
  >["data"] = [];
  {
    const perPage = 100;
    let page = 1;
    while (true) {
      const { data } = await octokit.pulls.listReviews({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      });
      if (data.length === 0) break;
      reviews.push(...data);
      if (data.length < perPage) break;
      page += 1;
    }
  }

  for (const r of reviews) {
    const login = r.user?.login ?? null;
    if (isBot(login)) continue;
    const role = classifyRole(login);
    if (!role) continue;

    let source: EventSource;
    if (r.state === "APPROVED") source = "REVIEW_APPROVED";
    else if (r.state === "CHANGES_REQUESTED") source = "REVIEW_CHANGES_REQUESTED";
    else source = "REVIEW_COMMENTED";

    // Prefer submitted_at; fallback to created_at so we don't drop reviews
    // that lack submitted_at (avoids wrongly treating last editor as earlier).
    const ts = r.submitted_at ?? (r as { created_at?: string }).created_at;
    if (!ts) continue;

    events.push({
      actor: login!,
      role,
      source,
      timestamp: ts,
    });
  }

  // Issue comments (discussion on the PR thread)
  {
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
      for (const c of data) {
        const login = c.user?.login ?? null;
        if (isBot(login)) continue;
        const role = classifyRole(login);
        if (!role) continue;
        events.push({
          actor: login!,
          role,
          source: "ISSUE_COMMENT",
          timestamp: c.created_at,
        });
      }
      if (data.length < perPage) break;
      page += 1;
    }
  }

  // Review comments (inline discussion)
  {
    const perPage = 100;
    let page = 1;
    while (true) {
      const { data } = await octokit.pulls.listReviewComments({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      });
      if (data.length === 0) break;
      for (const c of data) {
        const login = c.user?.login ?? null;
        if (isBot(login)) continue;
        const role = classifyRole(login);
        if (!role) continue;
        events.push({
          actor: login!,
          role,
          source: "REVIEW_COMMENT",
          timestamp: c.created_at,
        });
      }
      if (data.length < perPage) break;
      page += 1;
    }
  }

  // Commits (author events)
  {
    const perPage = 100;
    let page = 1;
    while (true) {
      const { data } = await octokit.pulls.listCommits({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      });
      if (data.length === 0) break;
      for (const commit of data) {
        const login =
          commit.author?.login ??
          commit.committer?.login ??
          commit.commit?.author?.name ??
          null;

        // We only care about commits that can be attributed to a GitHub login in our author set.
        const githubLogin = commit.author?.login ?? commit.committer?.login ?? null;
        if (isBot(githubLogin)) continue;
        const role = classifyRole(githubLogin);
        if (!role) continue;

        const ts =
          commit.commit.author?.date ??
          commit.commit.committer?.date ??
          null;
        if (!ts) continue;

        events.push({
          actor: githubLogin!,
          role,
          source: "COMMIT",
          timestamp: ts,
        });
      }
      if (data.length < perPage) break;
      page += 1;
    }
  }

  // Sort chronologically
  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return events;
}

