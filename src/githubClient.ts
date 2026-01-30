import { Octokit } from "@octokit/rest";
import { getGitHubTokens } from "./config";

class TokenRotator {
  private tokens: string[];
  private currentIndex: number = 0;
  private rateLimitResetTimes: Map<number, number> = new Map();

  constructor(tokens: string[]) {
    this.tokens = tokens.filter((t) => t && t.length > 0);
    if (this.tokens.length === 0) {
      throw new Error(
        "No GitHub tokens provided. Set GITHUB_TOKEN, GITHUB_TOKEN_2, GITHUB_TOKEN_3, and/or GITHUB_TOKEN_4 in .env file."
      );
    }
  }

  getCurrentToken(): string {
    return this.tokens[this.currentIndex];
  }

  rotateToken(): void {
    this.currentIndex = (this.currentIndex + 1) % this.tokens.length;
  }

  recordRateLimit(resetTimestamp: number): void {
    this.rateLimitResetTimes.set(this.currentIndex, resetTimestamp * 1000);
    this.rotateToken();
  }

  getTokenCount(): number {
    return this.tokens.length;
  }

  shouldWait(): { wait: boolean; waitMs: number } {
    const now = Date.now();
    const resetTimes = Array.from(this.rateLimitResetTimes.values()).filter(
      (resetTime) => resetTime > now
    );
    if (resetTimes.length === this.tokens.length && resetTimes.length > 0) {
      const nextReset = Math.min(...resetTimes);
      const waitMs = nextReset - now;
      return { wait: waitMs > 0, waitMs };
    }
    return { wait: false, waitMs: 0 };
  }
}

let tokenRotator: TokenRotator | null = null;

function getTokenRotator(): TokenRotator {
  if (!tokenRotator) {
    const tokens = getGitHubTokens();
    tokenRotator = new TokenRotator(tokens);
    console.log(`Initialized token rotator with ${tokenRotator.getTokenCount()} token(s)`);
  }
  return tokenRotator;
}

const REQUEST_TIMEOUT_MS = 30_000;
const TRANSIENT_RETRY_DELAY_MS = 4000;
const TRANSIENT_MAX_RETRIES = 3;

function createOctokitWithToken(token: string): Octokit {
  return new Octokit({
    auth: token,
    userAgent: "pr-attention-analyzer",
    request: {
      timeout: REQUEST_TIMEOUT_MS,
    },
  });
}

function isTransientError(error: any): boolean {
  if (!error) return false;
  // Connect/timeout (no response)
  if (error.cause?.code === "UND_ERR_CONNECT_TIMEOUT") return true;
  if (error.message?.includes("timeout") || error.message?.includes("Timeout")) return true;
  // Server/network errors
  const status = error.status;
  if (status === 500 || status === 502 || status === 503 || status === 504) return true;
  if (status === undefined && error.cause) return true; // e.g. fetch failed
  return false;
}

/**
 * Creates an Octokit instance with the current token and installs an error hook
 * that: (1) on 403/429 rotates the token and retries; (2) on timeouts/5xx retries
 * after a delay (same token). Each new instance gets the same hook.
 */
function createOctokitWithRetryHook(): Octokit {
  const rotator = getTokenRotator();
  const token = rotator.getCurrentToken();
  const octokit = createOctokitWithToken(token);

  octokit.hook.error("request", async (error: any, options: any) => {
    // Rate limit: rotate token and retry
    if (error?.status === 403 || error?.status === 429) {
      const resetHeader = error?.response?.headers?.["x-ratelimit-reset"];
      if (resetHeader) {
        const resetTimestamp = parseInt(String(resetHeader), 10);
        rotator.recordRateLimit(resetTimestamp);
        console.warn(
          `Rate limit hit. Rotating to next token. Reset at: ${new Date(resetTimestamp * 1000).toISOString()}`
        );

        const waitInfo = rotator.shouldWait();
        if (waitInfo.wait) {
          console.warn(
            `All tokens rate limited. Waiting ${Math.ceil(waitInfo.waitMs / 1000)}s...`
          );
          await new Promise((resolve) => setTimeout(resolve, waitInfo.waitMs));
        }

        const nextOctokit = createOctokitWithRetryHook();
        return nextOctokit.request(options);
      }
    }

    // Transient (timeout / 5xx): retry same request after delay, cap retries
    if (isTransientError(error)) {
      const retryCount = (options?.request as any)?.retryCount ?? 0;
      if (retryCount < TRANSIENT_MAX_RETRIES) {
        console.warn(
          `Request failed (timeout/5xx). Retry ${retryCount + 1}/${TRANSIENT_MAX_RETRIES} in ${TRANSIENT_RETRY_DELAY_MS / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, TRANSIENT_RETRY_DELAY_MS));
        const retryOptions = {
          ...options,
          request: { ...(options?.request ?? {}), retryCount: retryCount + 1 },
        };
        return octokit.request(retryOptions);
      }
    }

    throw error;
  });

  return octokit;
}

export function createOctokit(): Octokit {
  return createOctokitWithRetryHook();
}

