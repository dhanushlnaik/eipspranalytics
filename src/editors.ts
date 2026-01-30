import { Octokit } from "@octokit/rest";
import { EDITOR_CONFIG_PATH } from "./config";

export async function loadEditors(octokit: Octokit): Promise<Set<string>> {
  // eip-editors.yml lives in ethereum/EIPs and is canonical for all three repos.
  const [owner, repo] = ["ethereum", "EIPs"];

  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path: EDITOR_CONFIG_PATH,
  });

  if (!("content" in data)) {
    throw new Error(`Unexpected content type for ${EDITOR_CONFIG_PATH}`);
  }

  const decoded = Buffer.from(data.content, "base64").toString("utf8");
  // Very lightweight YAML parsing: look for GitHub logins that start with a dash or list item.
  // Example snippet patterns:
  // - github: someuser
  // or
  // github: someuser
  const editors = new Set<string>();
  const githubLineRegex = /github:\s*([A-Za-z0-9-]+)/;

  for (const line of decoded.split(/\r?\n/)) {
    const match = githubLineRegex.exec(line);
    if (match) {
      editors.add(match[1]);
    }
  }

  return editors;
}

