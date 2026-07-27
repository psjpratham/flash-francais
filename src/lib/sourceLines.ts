// Client-side mirror of supabase/functions/_shared/sourceLines.ts's line
// numbering (kept as a small, deliberate duplicate rather than a cross-
// runtime import — Deno edge functions and the Vite frontend build
// separately). Used only for the review UI's "view raw source lines" panel;
// the extraction/coverage-checking logic itself lives entirely server-side.

export interface SourceLine {
  id: string;
  text: string;
}

export function toSourceLines(rawText: string): SourceLine[] {
  const lines = rawText.replace(/\r\n/g, '\n').split('\n');
  return lines.map((text, i) => ({ id: `L${String(i + 1).padStart(3, '0')}`, text }));
}

export function formatNumberedSourceLines(rawText: string): string {
  return toSourceLines(rawText)
    .map((l) => `[${l.id}] ${l.text}`)
    .join('\n');
}
