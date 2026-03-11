export function splitPreambleAndBody(text: string) {
  const lines = text.split(/\r?\n/);

  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        const preamble = lines.slice(0, i + 1).join("\n");
        const body = lines.slice(i + 1).join("\n");
        return { preamble, body };
      }
    }
  }

  let i = 0;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      break;
    }
  }

  const preamble = lines.slice(0, i).join("\n");
  const body = lines.slice(i + 1).join("\n");
  return { preamble, body };
}

export function extractUniqueStatusFromText(text: string): string | null {
  const { preamble } = splitPreambleAndBody(text);
  return extractUniqueStatusFromPreamble(preamble);
}

export function extractUniqueStatusFromPreamble(preamble: string): string | null {
  const matches = preamble.match(/^status\s*:\s*(.+)$/gim) ?? [];
  if (matches.length !== 1) return null;

  const match = /^status\s*:\s*(.+)$/i.exec(matches[0]);
  return match?.[1]?.trim() ?? null;
}

export function stripStatusLinesFromPreamble(preamble: string): string {
  return preamble
    .split(/\r?\n/)
    .filter((line) => !/^status\s*:/i.test(line))
    .join("\n")
    .trim();
}

export function isPreambleStatusChangedOnly(baseText: string, headText: string): boolean {
  const baseParts = splitPreambleAndBody(baseText);
  const headParts = splitPreambleAndBody(headText);

  if (baseParts.body !== headParts.body) return false;

  const baseStatus = extractUniqueStatusFromPreamble(baseParts.preamble);
  const headStatus = extractUniqueStatusFromPreamble(headParts.preamble);
  if (baseStatus == null || headStatus == null || baseStatus === headStatus) {
    return false;
  }

  return (
    stripStatusLinesFromPreamble(baseParts.preamble) ===
    stripStatusLinesFromPreamble(headParts.preamble)
  );
}
