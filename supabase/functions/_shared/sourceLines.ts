// Turns a page's raw extracted text into stable, numbered source lines
// (L001, L002, ...) that both the extraction prompt and the deterministic
// coverage checker key off of. Blank lines are kept as part of the sequence
// (so line numbers stay stable across re-renders) but are never "meaningful"
// for coverage purposes.

export interface SourceLine {
  id: string;
  text: string;
}

export function toSourceLines(rawText: string): SourceLine[] {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  return lines.map((text, i) => ({ id: `L${String(i + 1).padStart(3, '0')}`, text }));
}

export function isMeaningfulLine(line: SourceLine): boolean {
  return line.text.trim() !== '';
}

export function formatNumberedLines(lines: SourceLine[]): string {
  return lines.map((l) => `[${l.id}] ${l.text}`).join('\n');
}

/** Whitespace/linebreak-only normalisation, matching the "harmless normalisation" the extraction rules allow. */
export function normalizeForComparison(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
