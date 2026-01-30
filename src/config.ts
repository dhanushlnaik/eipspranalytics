import dotenv from "dotenv";

dotenv.config();

export const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
export const GITHUB_TOKEN_2 = process.env.GITHUB_TOKEN_2;
export const GITHUB_TOKEN_3 = process.env.GITHUB_TOKEN_3;
export const GITHUB_TOKEN_4 = process.env.GITHUB_TOKEN_4;

export function getGitHubTokens(): string[] {
  const tokens: string[] = [];
  if (GITHUB_TOKEN) tokens.push(GITHUB_TOKEN);
  if (GITHUB_TOKEN_2) tokens.push(GITHUB_TOKEN_2);
  if (GITHUB_TOKEN_3) tokens.push(GITHUB_TOKEN_3);
  if (GITHUB_TOKEN_4) tokens.push(GITHUB_TOKEN_4);
  return tokens;
}

if (getGitHubTokens().length === 0) {
  // We don't throw here to allow help/usage, but analysis will fail without it.
  // The check is repeated where needed with a clearer error message.
}

export const TARGET_REPOS = [
  "ethereum/EIPs",
  "ethereum/ERCs",
  "ethereum/RIPs",
] as const;

/** Process EIPs first, then ERCs, then RIPs; merge at the end. */
export const REPO_ORDER: readonly string[] = [
  "ethereum/EIPs",
  "ethereum/ERCs",
  "ethereum/RIPs",
];

export type TargetRepo = (typeof TARGET_REPOS)[number];

export const EDITOR_CONFIG_PATH = "config/eip-editors.yml";

export const BOT_LOGIN_SUFFIX = "[bot]";

export const MONGODB_URI = process.env.OPENPRS_MONGODB_URI;
export const MONGODB_DATABASE = process.env.OPENPRS_DATABASE;

