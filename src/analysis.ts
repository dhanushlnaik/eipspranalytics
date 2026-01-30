import { TimelineEvent } from "./events";

export interface ActionSummary {
  type: string;
  date: string;
  actor?: string;
}

export interface AnalysisResult {
  needsEditorAttention: boolean;
  waitingSince: string | null;
  lastEditorAction: ActionSummary | null;
  lastAuthorAction: ActionSummary | null;
  reason: string;
}

export type PRType =
  | "DRAFT"
  | "TYPO"
  | "NEW_EIP"
  | "STATUS_CHANGE"
  | "WEBSITE"
  | "TOOLING"
  | "EIP_1"
  | "OTHER";

export interface PRClassification {
  type: PRType;
  isCreatedByBot: boolean;
  openedByPreambleAuthor?: boolean;
}

export interface CategorizedResult extends AnalysisResult {
  category: string;
  subcategory: string;
}

export function analyzeTimeline(events: TimelineEvent[]): AnalysisResult {
  const editorEvents = events.filter((e) => e.role === "EDITOR");
  const authorEvents = events.filter((e) => e.role === "AUTHOR");

  const lastEditorEvent =
    editorEvents.length > 0
      ? editorEvents[editorEvents.length - 1]
      : null;

  const lastAuthorEvent =
    authorEvents.length > 0
      ? authorEvents[authorEvents.length - 1]
      : null;

  if (!lastEditorEvent) {
    return {
      needsEditorAttention: true,
      waitingSince: null, // caller should use PR creation time
      lastEditorAction: null,
      lastAuthorAction: lastAuthorEvent
        ? {
            type: lastAuthorEvent.source,
            date: lastAuthorEvent.timestamp,
          }
        : null,
      reason:
        "No editor has interacted with this PR yet; it is waiting for initial editor attention.",
    };
  }

  const lastAuthorAfterEditor = authorEvents
    .filter((e) => e.timestamp > lastEditorEvent.timestamp)
    .slice(-1)[0] ?? null;

  if (lastAuthorAfterEditor) {
    return {
      needsEditorAttention: true,
      waitingSince: lastAuthorAfterEditor.timestamp,
      lastEditorAction: {
        type: lastEditorEvent.source,
        date: lastEditorEvent.timestamp,
        actor: lastEditorEvent.actor,
      },
      lastAuthorAction: {
        type: lastAuthorAfterEditor.source,
        date: lastAuthorAfterEditor.timestamp,
      },
      reason:
        "An editor interacted with the PR and the author has since responded; it is now waiting on editor attention.",
    };
  }

  // No author response after the last editor interaction: waiting on author.
  return {
    needsEditorAttention: false,
    waitingSince: null,
    lastEditorAction: {
      type: lastEditorEvent.source,
      date: lastEditorEvent.timestamp,
      actor: lastEditorEvent.actor,
    },
    lastAuthorAction: lastAuthorEvent
      ? {
          type: lastAuthorEvent.source,
          date: lastAuthorEvent.timestamp,
        }
      : null,
    reason:
      "An editor has interacted with the PR and there has been no author response since; it is waiting on the author.",
  };
}

const STAGNANT_THRESHOLD_DAYS = 90;

/** Tooling: title prefix or first word in PR body (CI, Bump, Config, Chore). */
const TOOLING_TITLE_PREFIX = /^(CI|Bump|Config|Chore):/i;
const TOOLING_FIRST_WORD = /^(CI|Bump|Config|Chore)$/i;
/** Title (or body) contains config/bump/ci/chore as a word, case-insensitive. */
const TOOLING_KEYWORD_IN_TITLE = /\b(config|bump|ci|chore)\b/i;

function getFirstWordFromBody(body: string | null | undefined): string | null {
  if (body == null || typeof body !== "string") return null;
  const trimmed = body.trim();
  if (!trimmed) return null;
  const first = trimmed.split(/\s+/)[0];
  return first != null && first.length > 0 ? first : null;
}

export function classifyPRType(params: {
  isDraft: boolean;
  isTypoLike: boolean;
  fileChanges: Array<{ filename: string; status: string; additions?: number; deletions?: number }>;
  prTitle?: string;
  prBody?: string | null;
}): PRClassification {
  const { isDraft, isTypoLike, fileChanges, prTitle = "", prBody } = params;

  if (isDraft) {
    return { type: "DRAFT", isCreatedByBot: false };
  }

  if (isTypoLike) {
    return { type: "TYPO", isCreatedByBot: false };
  }

  // Check for new EIP files (status = "added" and matches EIP pattern)
  const newEipFiles = fileChanges.filter(
    (f) =>
      f.status === "added" &&
      (f.filename.match(/EIPS\/eip-\d+\.md/i) ||
        f.filename.match(/ERCS\/erc-\d+\.md/i) ||
        f.filename.match(/RIPS\/rip-\d+\.md/i))
  );

  if (newEipFiles.length > 0) {
    return { type: "NEW_EIP", isCreatedByBot: false };
  }

  // Check for status changes in existing EIP files
  const modifiedEipFiles = fileChanges.filter(
    (f) =>
      f.status === "modified" &&
      (f.filename.match(/EIPS\/eip-\d+\.md/i) ||
        f.filename.match(/ERCS\/erc-\d+\.md/i) ||
        f.filename.match(/RIPS\/rip-\d+\.md/i)) &&
      (f.additions ?? 0) + (f.deletions ?? 0) < 20
  );

  if (modifiedEipFiles.length > 0) {
    return { type: "STATUS_CHANGE", isCreatedByBot: false };
  }

  // Website: files under website/ or title/body contains "website"
  const hasWebsiteFiles = fileChanges.some((f) =>
    f.filename.toLowerCase().startsWith("website/")
  );
  const textForWebsite = `${prTitle} ${prBody ?? ""}`.toLowerCase();
  if (hasWebsiteFiles || textForWebsite.includes("website")) {
    return { type: "WEBSITE", isCreatedByBot: false };
  }

  // Tooling (CI, Bump, Config): title prefix "CI:", "Bump:", etc.; or title/body contains word config|bump|ci|chore; or first word in body
  const titleIsToolingPrefix = TOOLING_TITLE_PREFIX.test(prTitle.trim());
  const titleContainsToolingKeyword = TOOLING_KEYWORD_IN_TITLE.test(prTitle);
  const bodyContainsToolingKeyword =
    prBody != null && TOOLING_KEYWORD_IN_TITLE.test(prBody);
  const firstWord = getFirstWordFromBody(prBody);
  const bodyFirstWordIsTooling =
    firstWord != null && TOOLING_FIRST_WORD.test(firstWord);
  if (
    titleIsToolingPrefix ||
    titleContainsToolingKeyword ||
    bodyContainsToolingKeyword ||
    bodyFirstWordIsTooling
  ) {
    return { type: "TOOLING", isCreatedByBot: false };
  }

  // EIP-1: touches EIP-1 / ERC-1 / RIP-1 file or title/body mentions EIP-1
  const hasEip1File = fileChanges.some(
    (f) =>
      /EIPS\/eip-1\.md$/i.test(f.filename) ||
      /ERCS\/erc-1\.md$/i.test(f.filename) ||
      /RIPS\/rip-1\.md$/i.test(f.filename)
  );
  const textForEip1 = `${prTitle} ${prBody ?? ""}`;
  if (hasEip1File || /eip-1|eip\-1/i.test(textForEip1)) {
    return { type: "EIP_1", isCreatedByBot: false };
  }

  return { type: "OTHER", isCreatedByBot: false };
}

export function categorizeResult(params: {
  result: AnalysisResult;
  classification: PRClassification;
  daysSinceLastActivity: number | null;
  prTitle: string;
}): CategorizedResult {
  const { result: baseResult, classification, daysSinceLastActivity, prTitle } =
    params;

  // Start from the timeline-based result, but allow small domain-specific
  // overrides for certain PR types.
  let result: AnalysisResult = { ...baseResult };

  // Special case: for Status Change / New EIP PRs opened by a non‑author where
  // there have been NO editor interactions and NO EIP author interactions yet,
  // treat the PR as waiting on authors rather than editors.
  //
  // Concretely: both lastEditorAction and lastAuthorAction are null, and the
  // PR opener is not an EIP preamble author.
  if (
    (classification.type === "STATUS_CHANGE" ||
      classification.type === "NEW_EIP") &&
    !classification.openedByPreambleAuthor &&
    !result.lastEditorAction &&
    !result.lastAuthorAction
  ) {
    result = {
      ...result,
      needsEditorAttention: false,
      waitingSince: null,
      reason:
        "This status-change PR has no editor or EIP author interactions yet; it is waiting on the EIP authors.",
    };
  }

  const isStagnant =
    !result.needsEditorAttention &&
    daysSinceLastActivity !== null &&
    daysSinceLastActivity >= STAGNANT_THRESHOLD_DAYS;

  // Determine subcategory based on attention state and stagnant status
  let subcategory: string;
  
  // For drafts: AWAITED when not stagnant, Stagnant when stagnant
  if (classification.type === "DRAFT") {
    if (isStagnant) {
      subcategory = "Stagnant";
    } else {
      subcategory = "AWAITED";
    }
  } else if (isStagnant) {
    subcategory = "Stagnant";
  } else if (result.needsEditorAttention) {
    subcategory = "Waiting on Editor";
  } else {
    subcategory = "Waiting on Author";
  }

  // Map PR type to category name
  let category: string;
  switch (classification.type) {
    case "DRAFT":
      category = "PR DRAFT";
      break;
    case "TYPO":
      category = "Typo";
      break;
    case "NEW_EIP":
      category = "New EIP";
      break;
    case "STATUS_CHANGE":
      category = "Status Change";
      break;
    case "WEBSITE":
      category = "Website";
      break;
    case "TOOLING":
      category = "Tooling";
      break;
    case "EIP_1":
      category = "EIP-1";
      break;
    default:
      category = "Other";
  }

  return {
    ...result,
    category,
    subcategory,
  };
}

