import fs from "fs";
import path from "path";

export interface CsvRow {
  repo: string;
  pr_number: number;
  pr_url: string;
  pr_title: string;
  created_at: string;
  days_open: number;
  needs_editor_attention: boolean;
  waiting_since: string | null;
  waiting_days: number | null;
  primary_reason: string;
  last_editor_action_date: string | null;
  last_author_action_date: string | null;
  category?: string;
  subcategory?: string;
}

export function writeCsv(rows: CsvRow[], outputPath: string): void {
  const headers = [
    "repo",
    "pr_number",
    "pr_url",
    "pr_title",
    "created_at",
    "days_open",
    "needs_editor_attention",
    "waiting_since",
    "waiting_days",
    "primary_reason",
    "last_editor_action_date",
    "last_author_action_date",
    "category",
    "subcategory",
  ];

  const lines: string[] = [headers.join(",")];

  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    const str = String(value);
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  for (const row of rows) {
    const waitingDays =
      row.waiting_since && !Number.isNaN(row.waiting_days)
        ? row.waiting_days
        : row.waiting_days;

    const values: (string | number | boolean | null)[] = [
      row.repo,
      row.pr_number,
      row.pr_url,
      row.pr_title,
      row.created_at,
      row.days_open,
      row.needs_editor_attention,
      row.waiting_since,
      waitingDays,
      row.primary_reason,
      row.last_editor_action_date,
      row.last_author_action_date,
      row.category ?? "",
      row.subcategory ?? "",
    ];

    lines.push(values.map(escape).join(","));
  }

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, lines.join("\n"), "utf8");
}

/**
 * Merge multiple CSV files (same schema) into one. First file's header is used;
 * subsequent files must have the same header (their header line is skipped).
 */
export function mergeCsvFiles(
  filePaths: string[],
  outputPath: string
): void {
  if (filePaths.length === 0) {
    fs.writeFileSync(outputPath, "", "utf8");
    return;
  }

  const lines: string[] = [];
  for (let i = 0; i < filePaths.length; i++) {
    const p = filePaths[i];
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, "utf8").trim();
    const fileLines = content ? content.split("\n") : [];
    if (fileLines.length === 0) continue;
    if (i === 0) {
      lines.push(...fileLines);
    } else {
      lines.push(...fileLines.slice(1));
    }
  }

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, lines.join("\n"), "utf8");
}

