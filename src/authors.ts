import { Octokit } from "@octokit/rest";

// Very lightweight author extraction from EIP/ERC/RIP preambles.
// We look for lines starting with "author:" and then GitHub handles in the form "@handle".

const AUTHOR_LINE_REGEX = /^author\s*:/i;
const HANDLE_REGEX = /@([A-Za-z0-9-]+)/g;

export async function extractAuthorsFromFiles(params: {
  octokit: Octokit;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
}): Promise<Set<string>> {
  const { octokit, owner, repo, pullNumber, headSha } = params;

  const files: string[] = [];

  const perPage = 100;
  let page = 1;

  // Collect candidate Markdown files that look like EIPs/ERCs/RIPs
  // (heuristic but deterministic and conservative).
  // We avoid fetching non-markdown content.
  while (true) {
    const { data } = await octokit.pulls.listFiles({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: perPage,
      page,
    });

    if (data.length === 0) break;

    for (const f of data) {
      if (!f.filename.toLowerCase().endsWith(".md")) continue;
      if (
        f.filename.startsWith("EIPS/") ||
        f.filename.startsWith("ERCS/") ||
        f.filename.startsWith("RIPS/") ||
        f.filename.toLowerCase().includes("eip") ||
        f.filename.toLowerCase().includes("erc") ||
        f.filename.toLowerCase().includes("rip")
      ) {
        files.push(f.filename);
      }
    }

    if (data.length < perPage) break;
    page += 1;
  }

  const authors = new Set<string>();

  for (const path of files) {
    try {
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path,
        ref: headSha,
      });

      if (!("content" in data)) continue;

      const text = Buffer.from(data.content, "base64").toString("utf8");
      const lines = text.split(/\r?\n/);

      for (const line of lines) {
        if (!AUTHOR_LINE_REGEX.test(line)) continue;

        let match: RegExpExecArray | null;
        while ((match = HANDLE_REGEX.exec(line)) !== null) {
          authors.add(match[1]);
        }

        // Stop after the first author line in a given file to avoid noise.
        break;
      }
    } catch {
      // If we cannot load a file for any reason, we skip it.
      continue;
    }
  }

  return authors;
}

