# Category & Subcategory Logic

This document explains how each open PR gets its **category** and **subcategory** in the CSV output. The logic is deterministic and based only on observable GitHub data and file/title heuristics.

---

## Overview

| Output | Meaning |
|--------|--------|
| **category** | What kind of PR it is: `PR DRAFT`, `Typo`, `New EIP`, `Status Change`, `Website`, `Tooling`, `EIP-1`, or `Content Edit`. |
| **subcategory** | Who the PR is waiting on (or if it’s stale): `Waiting on Editor`, `Waiting on Author`, `Stagnant`, or `AWAITED` (drafts not stagnant). |

**Where it lives**

- **PR type → category**: `src/analysis.ts` → `classifyPRType()`; overrides in `src/index.ts`.
- **Timeline → who it’s waiting on**: `src/analysis.ts` → `analyzeTimeline()`, then `categorizeResult()` (which also applies overrides and sets subcategory).

---

## 1. PR type classification (→ category)

PR type is decided **first**; it is then mapped 1:1 to the **category** label. Order is **first match wins**.

### 1.1 Draft

- **Condition**: `pr.draft === true`.
- **Type**: `DRAFT` → **category** = `PR DRAFT`.
- **Code**: `src/analysis.ts`, `classifyPRType()` — first check:

```ts
if (isDraft) {
  return { type: "DRAFT", isCreatedByBot: false };
}
```

- **Input**: `isDraft` comes from `pr.draft` in `src/index.ts`.

---

### 1.2 Typo

- **Condition**: Title matches typo/grammar **and** small diff, excluding branch-conflicted PRs:
  - Title: `/typo|grammar|spelling/i`
  - `changed_files ≤ 5`
  - `additions + deletions < 50`
  - PR is mergeable / has no branch conflicts (exclude `mergeable_state === "dirty"` or `mergeable === false`)
- **Type**: `TYPO` → **category** = `Typo`.
- **Code**: `src/index.ts` builds `isTypoLike`; `src/analysis.ts` uses it in `classifyPRType()`:

```ts
// index.ts (updated)
// Exclude PRs with branch conflicts (mergeable_state === "dirty" or mergeable === false)
const hasBranchConflict =
  (prDetails.mergeable_state ?? "").toLowerCase() === "dirty" ||
  prDetails.mergeable === false;
const isTypoLike =
  /typo|grammar|spelling/i.test(prTitle) &&
  (prDetails.changed_files ?? 0) <= 5 &&
  ((prDetails.additions ?? 0) + (prDetails.deletions ?? 0)) < 50 &&
  !hasBranchConflict;

// analysis.ts
if (isTypoLike) {
  return { type: "TYPO", isCreatedByBot: false };
}
```

---

### 1.3 New EIP

- **Condition**: At least one **added** file whose path matches:
  - `EIPS/eip-<number>.md`, or
  - `ERCS/erc-<number>.md`, or
  - `RIPS/rip-<number>.md`
- **Type**: `NEW_EIP` → **category** = `New EIP`.
- **Code**: `src/analysis.ts`, `classifyPRType()`:

```ts
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
```

- **Input**: `fileChanges` from `octokit.pulls.listFiles()` in `src/index.ts`.

---

### 1.4 Status change (by files)

- **Condition**: At least one **modified** EIP/ERC/RIP `.md` file whose change is limited to the preamble `status:` line (preamble-only change). We conservatively detect this by comparing base vs head file contents: the body must be identical and only the `status:` value in the preamble differs.
- **Type**: `STATUS_CHANGE` → **category** = `Status Change`.
- **Code**: `src/analysis.ts`, `classifyPRType()` — the importer/enricher computes a `preambleStatusChangedOnly` flag for modified EIP/ERC/RIP files and `classifyPRType()` treats files with that flag as status changes:

```ts
// analysis.ts
const modifiedEipFiles = fileChanges.filter(
  (f) =>
    f.status === "modified" &&
    (f.filename.match(/EIPS\/eip-\d+\.md/i) ||
      f.filename.match(/ERCS\/erc-\d+\.md/i) ||
      f.filename.match(/RIPS\/rip-\d+\.md/i)) &&
    f.preambleStatusChangedOnly === true
);
if (modifiedEipFiles.length > 0) {
  return { type: "STATUS_CHANGE", isCreatedByBot: false };
}
```

---

### 1.5 Status change (by title override)

- **Condition**: Type would still be `OTHER` **after** the above, **and**:
  - Title matches `/status|move|withdraw|finalize|supersede/i`, and
  - At least one **modified** EIP/ERC/RIP file (any diff size).
- **Effect**: Type is overridden to `STATUS_CHANGE` → **category** = `Status Change`.
- **Code**: `src/index.ts` (after `classifyPRType()`):

```ts
const isStatusChangeLike =
  /status|move|withdraw|finalize|supersede/i.test(prTitle);
if (
  !isDraft &&
  !isTypoLike &&
  classification.type === "OTHER" &&
  isStatusChangeLike
) {
  const hasModifiedEipFiles = fileChanges.some(
    (f) =>
      f.status === "modified" &&
      (f.filename.match(/EIPS\/eip-\d+\.md/i) || ...)
  );
  if (hasModifiedEipFiles) {
    classification.type = "STATUS_CHANGE";
  }
}
```

---

### 1.6 Website

- **Condition**: Any changed file path starts with `website/`, **or** title/body contains the word `"website"` (case-insensitive).
- **Type**: `WEBSITE` → **category** = `Website`.
- **Code**: `src/analysis.ts`, `classifyPRType()`:

```ts
const hasWebsiteFiles = fileChanges.some((f) =>
  f.filename.toLowerCase().startsWith("website/")
);
const textForWebsite = `${prTitle} ${prBody ?? ""}`.toLowerCase();
if (hasWebsiteFiles || textForWebsite.includes("website")) {
  return { type: "WEBSITE", isCreatedByBot: false };
}
```

- **Input**: `fileChanges`, `prTitle`, `prBody` (PR description from `prDetails.body`).

---

### 1.7 Tooling (CI, Bump, Config)

- **Condition**: **Any** of:
  1. **Title prefix**: PR title starts with `CI:`, `Bump:`, `Config:`, or `Chore:` (case-insensitive).
  2. **Title contains keyword**: PR title contains the word `config`, `bump`, `ci`, or `chore` as a whole word (case-insensitive, word boundary).
  3. **Body contains keyword**: PR description contains the word `config`, `bump`, `ci`, or `chore` as a whole word (case-insensitive).
  4. **First word in PR description**: The first word of the PR body is exactly `CI`, `Bump`, `Config`, or `Chore` (case-insensitive).
- **Type**: `TOOLING` → **category** = `Tooling`.
- **Code**: `src/analysis.ts`, `classifyPRType()`:

```ts
const TOOLING_TITLE_PREFIX = /^(CI|Bump|Config|Chore):/i;
const TOOLING_FIRST_WORD = /^(CI|Bump|Config|Chore)$/i;
const TOOLING_KEYWORD_IN_TITLE = /\b(config|bump|ci|chore)\b/i;
// ...
const titleIsToolingPrefix = TOOLING_TITLE_PREFIX.test(prTitle.trim());
const titleContainsToolingKeyword = TOOLING_KEYWORD_IN_TITLE.test(prTitle);
const bodyContainsToolingKeyword = prBody != null && TOOLING_KEYWORD_IN_TITLE.test(prBody);
const bodyFirstWordIsTooling = firstWord != null && TOOLING_FIRST_WORD.test(firstWord);
if (titleIsToolingPrefix || titleContainsToolingKeyword || bodyContainsToolingKeyword || bodyFirstWordIsTooling) {
  return { type: "TOOLING", isCreatedByBot: false };
}
```

- **Input**: `prTitle`, `prBody`. User-facing label is always **Tooling** (CI/Bump/Config are not shown separately).

---

### 1.8 EIP-1

- **Condition**: The PR actually touches the `EIPS/eip-1.md`, `ERCS/erc-1.md`, or `RIPS/rip-1.md` file. We do **not** classify a PR as EIP-1 based on title or body mentions.
- **Type**: `EIP_1` → **category** = `EIP-1`.
- **Code**: `src/analysis.ts`, `classifyPRType()`:

```ts
const hasEip1File = fileChanges.some(
  (f) =>
    /EIPS\/eip-1\.md$/i.test(f.filename) ||
    /ERCS\/erc-1\.md$/i.test(f.filename) ||
    /RIPS\/rip-1\.md$/i.test(f.filename)
);
if (hasEip1File) {
  return { type: "EIP_1", isCreatedByBot: false };
}
```

---

### 1.9 Content Edit

- **Condition**: None of the above.
- **Type**: `OTHER` → **category** = `Content Edit`.

---

## 2. Timeline: who is the PR waiting on?

Before subcategory is chosen, we compute **whether the PR needs editor attention** from the event timeline. Only **editors** (from `config/eip-editors.yml`) and **authors** (from EIP/ERC/RIP preamble `author:` lines) count; the PR opener counts as author only if they appear in the preamble. Bots are ignored.

- **Code**: `src/events.ts` builds the timeline; `src/analysis.ts` → `analyzeTimeline(events)` returns:
  - `needsEditorAttention`: `true` = waiting on editor, `false` = waiting on author.
  - `lastEditorAction` / `lastAuthorAction` (or null).

**Decision tree (analysis.ts):**

1. **No editor has ever interacted**  
   → `needsEditorAttention = true` (waiting on editor).

2. **At least one editor event**  
   - If there is **any author event after the last editor event**  
     → `needsEditorAttention = true` (author replied; now waiting on editor again).  
   - Else  
     → `needsEditorAttention = false` (waiting on author).

---

## 3. Override: non-author Status Change / New EIP

For **Status Change** and **New EIP** only, we override “waiting on” when the PR is opened by a **non–preamble author** and there is **no** editor or author activity yet:

- **Condition**:  
  `(type === STATUS_CHANGE || type === NEW_EIP)` **and**  
  `!openedByPreambleAuthor` **and**  
  `!lastEditorAction` **and**  
  `!lastAuthorAction`
- **Effect**: Set `needsEditorAttention = false` and reason to “waiting on the EIP authors.”  
  So subcategory will be **Waiting on Author**, not **Waiting on Editor**.

**Code**: `src/analysis.ts`, `categorizeResult()`:

```ts
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
```

- **Input**: `openedByPreambleAuthor` is set in `src/index.ts` from `authors.has(prAuthorLogin)` after `extractAuthorsFromFiles()`.

---

## 4. Stagnant

A PR is **stagnant** only when **all** of:

- `needsEditorAttention === false` (already “waiting on author”), and  
- `daysSinceLastActivity !== null`, and  
- `daysSinceLastActivity >= 90`.

So only “waiting on author” PRs can be marked stagnant; “waiting on editor” PRs are never marked stagnant by time.

**Code**: `src/analysis.ts`, `categorizeResult()`:

```ts
const STAGNANT_THRESHOLD_DAYS = 90;
const isStagnant =
  !result.needsEditorAttention &&
  daysSinceLastActivity !== null &&
  daysSinceLastActivity >= STAGNANT_THRESHOLD_DAYS;
```

---

## 5. Subcategory decision tree

Subcategory is chosen **after** the timeline result and the Status Change/New EIP override (and stagnant) are applied. **Order of checks:**

| # | Condition | Subcategory |
|---|-----------|-------------|
| 1 | Type is **DRAFT** and **not** stagnant | `AWAITED` |
| 2 | Type is **DRAFT** and stagnant | `Stagnant` |
| 3 | **Stagnant** (waiting on author + ≥90 days inactive) | `Stagnant` |
| 4 | `needsEditorAttention === true` | `Waiting on Editor` |
| 5 | Else | `Waiting on Author` |

**Code**: `src/analysis.ts`, `categorizeResult()`:

```ts
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
```

Category label is then set from `classification.type` (e.g. `DRAFT` → `PR DRAFT`, `STATUS_CHANGE` → `Status Change`).

---

## 6. Quick reference

**Category (PR type)**  
`PR DRAFT` | `Typo` | `New EIP` | `Status Change` | `Website` | `Tooling` | `EIP-1` | `Content Edit`  
→ From `classifyPRType()` + title override in `index.ts`. Tooling combines CI, Bump, Config (title prefix or first word in description).

**Subcategory (waiting state)**  
`Waiting on Editor` | `Waiting on Author` | `Stagnant` | `""`  
→ From `analyzeTimeline()` + override in `categorizeResult()` + stagnant rule, then the subcategory if/else above.

**Files**

- `src/analysis.ts`: `classifyPRType()`, `analyzeTimeline()`, `categorizeResult()`.
- `src/index.ts`: `isTypoLike`, `isStatusChangeLike`, title override, `openedByPreambleAuthor`, calls to analysis.
- `src/events.ts`: timeline building (editor/author roles).
