# Open PR Review Logic

This document explains the current open-PR categorization and review-routing logic in this repo, including the recent changes around:

- stricter `Status Change` detection
- `eth-bot` review-comment parsing
- editor-vs-author routing
- exclusions for merge conflicts and `status: Stagnant`

It is meant to answer: "what does this PR-processing flow do, and where is each part implemented?"

---

## High-level flow

For each PR, the system does four main things:

1. Fetch PR metadata, changed files, comments, and timeline-related activity from GitHub.
2. Classify the PR type, for example `New EIP`, `Status Change`, `Typo`, or `Content Edit`.
3. Decide whether the PR is currently waiting on editors or authors.
4. Store the final `category` and `subcategory` for boards, snapshots, and API responses.

There are two main execution paths:

- Live/CLI analysis: [src/index.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/index.ts)
- Mongo import path: [src/mongo/import-job.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/mongo/import-job.ts)

Both now use the same core logic modules:

- Review/timeline logic: [src/analysis.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/analysis.ts)
- Timeline/event collection: [src/events.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/events.ts)
- Preamble parsing: [src/preamble.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/preamble.ts)
- `eth-bot` comment parsing: [src/ethBot.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/ethBot.ts)
- Author extraction: [src/authors.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/authors.ts)
- Editor loading: [src/editors.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/editors.ts)

---

## Final outputs

Each open PR ends up with:

- a `category`
- a `subcategory`
- a waiting/attention reason

Common outputs:

- Categories: `PR DRAFT`, `Typo`, `New EIP`, `Status Change`, `Website`, `Tooling`, `EIP-1`, `Content Edit`
- Subcategories: `Waiting on Editor`, `Waiting on Author`, `Stagnant`, `AWAITED`

The board/API layer reads those stored values; it does not recompute the logic on every request.

Relevant board read path:

- [src/api/board-service.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/api/board-service.ts)

That means logic changes require a re-import to refresh existing stored PR rows.

---

## PR type classification

PR type classification lives in:

- [src/analysis.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/analysis.ts)

The main entry point is `classifyPRType()`.

This decides:

- `DRAFT`
- `TYPO`
- `NEW_EIP`
- `STATUS_CHANGE`
- `WEBSITE`
- `TOOLING`
- `EIP_1`
- `OTHER`

### Status Change logic

This area was tightened recently.

We no longer treat a PR as `Status Change` just because the title looks like a status update. Instead, the file-level status-change signal must be real.

The shared implementation is in:

- [src/preamble.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/preamble.ts)

Key helper:

- `isPreambleStatusChangedOnly(baseText, headText)`

What it checks:

1. Split preamble vs body correctly, including YAML-style `---` frontmatter.
2. Extract exactly one `status:` line from each preamble.
3. Require the body to be unchanged.
4. Require the `status:` value to actually change.
5. Require the rest of the preamble to stay the same after removing the `status:` line.

So this is now excluded:

- same `status:` value with unrelated preamble edits
- malformed preambles with duplicate `status:` lines
- any change outside a pure status-only preamble update

Where it is used:

- [src/index.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/index.ts)
- [src/mongo/import-job.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/mongo/import-job.ts)

---

## Timeline and who the PR is waiting on

The base editor-vs-author decision tree is split into two stages.

### 1. Gather timeline events

Implemented in:

- [src/events.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/events.ts)

This collects:

- PR opened
- reviews
- issue comments
- review comments
- commits

Actors are grouped into:

- `EDITOR`
- `AUTHOR`
- `OTHER`

Editor membership comes from:

- [src/editors.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/editors.ts)

Author membership comes from EIP/ERC/RIP preambles:

- [src/authors.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/authors.ts)

### 2. Decide waiting on editor vs waiting on author

Implemented in:

- [src/analysis.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/analysis.ts)

Main helper:

- `analyzeTimeline(events)`

Base rules:

1. No editor activity yet -> `Waiting on Editor`
2. Last editor acted and there has been no author response after that -> `Waiting on Author`
3. Author responded after the last editor action -> `Waiting on Editor`

This is still the core "decision tree thingy" and remains intact.

---

## `eth-bot` reviewer comment logic

This was added so editor-review routing is based on the bot’s reviewer request comment instead of guessing entirely from activity.

Implemented in:

- [src/ethBot.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/ethBot.ts)

Main helper:

- `getEthBotReviewSignal(...)`

What it does:

1. Loads PR issue comments.
2. Finds the first `eth-bot` or `eth-bot[bot]` comment that contains:

   `Requires N more reviewers from ...`

3. Extracts all mentioned GitHub handles from that reviewer-request line.
4. Compares those handles against the loaded editor set.

Outputs:

- `needsEditorReview = true` if every mentioned handle is an editor
- `needsEditorReview = false` if even one mentioned handle is not an editor
- `null` if no matching `eth-bot` reviewer-request comment is found

### Important nuance

The `eth-bot` result does not replace the timeline decision tree completely.

Current behavior:

- If `eth-bot` mentions any non-editor reviewer, the PR is treated as waiting on authors.
- If `eth-bot` mentions only editors, the old last-activity timeline still decides whether it is currently waiting on editors or authors.

That means:

- bot says editors only + latest relevant state still waiting on editor -> `Waiting on Editor`
- bot says editors only + last relevant editor activity means author owes the next response -> `Waiting on Author`

This logic is applied in:

- [src/analysis.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/analysis.ts)

and is fed from:

- [src/index.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/index.ts)
- [src/mongo/import-job.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/mongo/import-job.ts)

---

## Exclusions from editor review

Even if the PR would otherwise be waiting on editors, we exclude it from editor review in these cases:

### 1. Merge conflicts

Checked from GitHub PR metadata:

- `mergeable_state === "dirty"`
- or `mergeable === false`

Where:

- [src/index.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/index.ts)
- [src/mongo/import-job.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/mongo/import-job.ts)

### 2. Preamble status is `Stagnant`

If the current head version of a changed EIP/ERC/RIP file has preamble:

- `status: Stagnant`

then the PR is excluded from editor review.

The status extraction uses:

- [src/preamble.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/preamble.ts)

and is applied in:

- [src/index.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/index.ts)
- [src/mongo/import-job.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/mongo/import-job.ts)

### 3. Fallback non-editor-participant rule

There is still a fallback rule from the older logic:

- if there is no usable `eth-bot` reviewer signal
- and the PR has non-editor/non-author participants

then it is excluded from editor review

This only applies when the `eth-bot` reviewer comment was not found or could not be parsed.

The fallback lives in:

- [src/analysis.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/analysis.ts)

---

## What is explicitly ignored

These GitHub UI signals are not currently used:

- the "Review required" panel
- code owner review required
- pending review UI cards
- successful/failing/pending checks UI

Checks-based exclusion was briefly added, then removed. The current logic only uses merge-conflict state, not general CI/check completion.

---

## Draft handling

Draft PRs skip most of the active editor/author routing logic.

They are categorized as:

- category: `PR DRAFT`
- subcategory: `AWAITED` unless stagnant by time

Draft handling is done in:

- [src/analysis.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/analysis.ts)
- [src/index.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/index.ts)
- [src/mongo/import-job.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/mongo/import-job.ts)

---

## Where the final decision is made

The final decision point is:

- `categorizeResult(...)` in [src/analysis.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/analysis.ts)

This combines:

- base timeline result
- PR type special cases
- `eth-bot` reviewer routing
- merge-conflict exclusion
- `Stagnant` preamble exclusion
- stagnant-by-time subcategory handling

This function produces the final:

- `category`
- `subcategory`
- `needsEditorAttention`
- `reason`

---

## Operational note

Because boards and APIs read stored Mongo documents, logic changes do not retroactively update already-imported PRs.

After changing this logic, rerun:

```bash
npm run mongo:import
```

or, if you also want snapshots/charts refreshed:

```bash
npm run mongo:sync
```

---

## Summary of the recent changes

Recent work in this area did the following:

1. Tightened `Status Change` detection to require a real preamble `status:` change.
2. Added shared preamble parsing helpers so live and Mongo paths behave the same.
3. Added `eth-bot` reviewer-comment parsing.
4. Made editor-review routing depend on whether `eth-bot` mentions only editors or also non-editors.
5. Preserved the original last-activity decision tree after the `eth-bot` gate.
6. Added exclusions for merge conflicts and preamble `status: Stagnant`.
7. Explicitly left GitHub checks/review panels out of scope.

If this logic changes again, this doc should be updated alongside:

- [src/analysis.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/analysis.ts)
- [src/events.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/events.ts)
- [src/ethBot.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/ethBot.ts)
- [src/preamble.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/preamble.ts)
- [src/index.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/index.ts)
- [src/mongo/import-job.ts](/Users/dhanushlnaik/Workspace/Dev/Avarch/eipspranalytics/src/mongo/import-job.ts)
