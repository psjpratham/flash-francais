// Deterministic completeness/fidelity checks — "nothing missing" is
// technically verified here, never just trusted from the model. Runs after
// JSON-schema validation on every extraction attempt; its result decides
// whether the (more expensive) completeness-audit prompt is worth running.

import { isMeaningfulLine, normalizeForComparison, type SourceLine } from './sourceLines.ts';

export interface CoverageBlockInput {
  order_index: number;
  source_line_ids: string[];
  source_text: string;
  translation: string | null;
}

export interface AlteredTextIssue {
  lineIds: string[];
  issue: string;
}

export interface CoverageResult {
  missingLineIds: string[];
  duplicatedLineIds: string[];
  alteredText: AlteredTextIssue[];
  orderingIssues: string[];
  invalidLineReferences: string[];
  /** order_index of every block with real content (non-empty source_text) but no translation — unlike everything else here, translation quality was previously never deterministically checked at all, only self-audited by the model. */
  missingTranslationOrderIndexes: number[];
}

function lineIndex(id: string): number {
  const n = parseInt(id.replace(/^L/, ''), 10);
  return Number.isFinite(n) ? n : -1;
}

export function checkCoverage(sourceLines: SourceLine[], blocks: CoverageBlockInput[]): CoverageResult {
  const byId = new Map(sourceLines.map((l) => [l.id, l]));
  const meaningfulIds = new Set(sourceLines.filter(isMeaningfulLine).map((l) => l.id));

  const invalidLineReferences: string[] = [];
  const seenCount = new Map<string, number>();
  const alteredText: AlteredTextIssue[] = [];

  for (const block of blocks) {
    for (const id of block.source_line_ids) {
      if (!byId.has(id)) {
        invalidLineReferences.push(id);
        continue;
      }
      seenCount.set(id, (seenCount.get(id) ?? 0) + 1);
    }

    if (block.source_line_ids.length > 0) {
      const referencedText = block.source_line_ids
        .filter((id) => byId.has(id))
        .map((id) => byId.get(id)!.text)
        .join(' ');
      const expected = normalizeForComparison(referencedText);
      const actual = normalizeForComparison(block.source_text);
      // A block's source_text may legitimately be a subset of long
      // multi-purpose lines (e.g. one line holding several exercise items
      // split across blocks) — only flag drift when neither is a substring
      // of the other, i.e. genuinely different wording rather than a split.
      if (expected && actual && !expected.includes(actual) && !actual.includes(expected)) {
        alteredText.push({ lineIds: block.source_line_ids, issue: 'source_text does not match the referenced source lines' });
      }
    }
  }

  const duplicatedLineIds = [...seenCount.entries()].filter(([, count]) => count > 1).map(([id]) => id);

  const coveredIds = new Set(seenCount.keys());
  const missingLineIds = [...meaningfulIds].filter((id) => !coveredIds.has(id));

  const orderingIssues: string[] = [];
  const sorted = [...blocks].sort((a, b) => a.order_index - b.order_index);
  let lastIndex = -1;
  for (const block of sorted) {
    const indices = block.source_line_ids.map(lineIndex).filter((n) => n >= 0);
    if (!indices.length) continue;
    const minIndex = Math.min(...indices);
    if (minIndex < lastIndex) {
      orderingIssues.push(`block at order_index ${block.order_index} references earlier lines out of sequence`);
    }
    lastIndex = Math.max(lastIndex, ...indices);
  }

  const missingTranslationOrderIndexes = blocks.filter((b) => b.source_text.trim() !== '' && !(b.translation ?? '').trim()).map((b) => b.order_index);

  return { missingLineIds, duplicatedLineIds, alteredText, orderingIssues, invalidLineReferences, missingTranslationOrderIndexes };
}

export function coverageHasIssues(result: CoverageResult): boolean {
  return (
    result.missingLineIds.length > 0 ||
    result.duplicatedLineIds.length > 0 ||
    result.alteredText.length > 0 ||
    result.orderingIssues.length > 0 ||
    result.invalidLineReferences.length > 0 ||
    result.missingTranslationOrderIndexes.length > 0
  );
}
