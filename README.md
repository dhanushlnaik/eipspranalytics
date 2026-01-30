## PR Attention Analyzer

This tool implements the decision model described in your PRD to answer, for each open pull request in the Ethereum standards repositories:

> **Does this PR currently need editor attention, and since when?**

It operates purely on observable GitHub activity and does not rely on labels.

### How it works

- **Editor source of truth**: Editors are discovered from `config/eip-editors.yml` in `ethereum/EIPs`.
- **Authors**: The tool parses the `author:` preamble lines of EIP/ERC/RIP markdown files in each PR for GitHub handles (e.g. `@someuser`). The PR opener is treated as an author fallback.
- **Events**:
  - **Editor events**: Reviews (APPROVED, CHANGES_REQUESTED, COMMENTED), issue comments, and review comments where the actor is in the editor set.
  - **Author events**: Commits, issue comments, and review comments where the actor is in the author set (or the PR opener).
  - Bots (`* [bot]` logins) are ignored.
  - Draft PRs are skipped.
- **Decision model**:
  - If **no editor events** exist: the PR **needs editor attention**, waiting since PR creation.
  - Else, if an **author event occurs after the last editor event**: the PR **needs editor attention**, waiting since that author event.
  - Else: the PR is **waiting on the author**, and editor attention is not required.
- **Output**:
  - A per-PR JSON analysis printed to stdout.
  - An aggregate CSV with one row per PR, suitable for dashboards or further processing.

### Installation

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file with GitHub token(s):

```bash
echo "GITHUB_TOKEN=your_personal_access_token_here" > .env
```

For token rotation (to handle rate limits), you can add up to 4 tokens:

```bash
echo "GITHUB_TOKEN=token1" > .env
echo "GITHUB_TOKEN_2=token2" >> .env
echo "GITHUB_TOKEN_3=token3" >> .env
echo "GITHUB_TOKEN_4=token4" >> .env
```

The tokens only need `public_repo` scope for public data. The tool will automatically rotate between tokens when rate limits are hit.

### Usage

Build the project:

```bash
npm run build
```

Run the analyzer (default: all three repos, CSV at `output/pr-analysis.csv`):

```bash
npm run analyze
```

Or directly:

```bash
node dist/index.js
```

#### Options

- **Limit to a specific repo**:

```bash
node dist/index.js --repo ethereum/EIPs
```

- **Custom CSV path**:

```bash
node dist/index.js --csv my-output.csv
```

- **Help**:

```bash
node dist/index.js --help
```

### CSV schema

The generated CSV has the following columns:

```csv
repo,
pr_number,
pr_url,
pr_title,
created_at,
days_open,
needs_editor_attention,
waiting_since,
waiting_days,
primary_reason,
last_editor_action_date,
last_author_action_date,
category,
subcategory
```

The `category` column is derived and non-overlapping:

- `PR DRAFT` — Draft PRs
- `Typo` — Small typo/grammar fixes
- `New EIP` — PRs that add new EIP/ERC/RIP files
- `Status Change` — PRs that change status in existing EIP files
- `Website` — Website-related changes (files under `website/` or title/body mentions "website")
- `Tooling` — CI, Bump, Config (title prefix `CI:`, `Bump:`, etc. or first word in description)
- `EIP-1` — EIP-1 / process changes (touches `eip-1.md` or title/body mentions EIP-1)
- `Other` — Everything else

The `subcategory` column indicates who the PR is waiting on: `Waiting on Editor`, `Waiting on Author`, `Stagnant`, or empty (drafts). See [CATEGORY_LOGIC.md](./CATEGORY_LOGIC.md) for full logic.

### Notes & limitations

- Author detection currently relies on GitHub handles in `author:` lines and the PR opener as a fallback. If metadata is missing or non-standard, some author events may be missed.
- The logic is deterministic and based only on GitHub timelines; off-GitHub discussions are not visible to the analyzer.
- The decision model is implemented exactly as described in the PRD; if you adjust the process, the code can be updated to match.

