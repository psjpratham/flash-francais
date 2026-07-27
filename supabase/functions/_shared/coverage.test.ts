import { describe, expect, it } from 'vitest';
import { toSourceLines } from './sourceLines';
import { checkCoverage, coverageHasIssues } from './coverage';

describe('checkCoverage', () => {
  it('reports no issues when every meaningful line is covered exactly once, in order', () => {
    const lines = toSourceLines('Leçon 1\nBonjour le monde');
    const coverage = checkCoverage(lines, [
      { order_index: 0, source_line_ids: ['L001'], source_text: 'Leçon 1', translation: 'Lesson 1' },
      { order_index: 1, source_line_ids: ['L002'], source_text: 'Bonjour le monde', translation: 'Hello world' },
    ]);
    expect(coverageHasIssues(coverage)).toBe(false);
  });

  it('detects a meaningful source line missing from every block', () => {
    const lines = toSourceLines('Leçon 1\nBonjour le monde');
    const coverage = checkCoverage(lines, [{ order_index: 0, source_line_ids: ['L001'], source_text: 'Leçon 1' }]);
    expect(coverage.missingLineIds).toEqual(['L002']);
  });

  it('never flags blank lines as missing', () => {
    const lines = toSourceLines('Leçon 1\n\nBonjour');
    const coverage = checkCoverage(lines, [
      { order_index: 0, source_line_ids: ['L001'], source_text: 'Leçon 1' },
      { order_index: 1, source_line_ids: ['L003'], source_text: 'Bonjour' },
    ]);
    expect(coverage.missingLineIds).toEqual([]);
  });

  it('detects a source line referenced by more than one block', () => {
    const lines = toSourceLines('Bonjour le monde');
    const coverage = checkCoverage(lines, [
      { order_index: 0, source_line_ids: ['L001'], source_text: 'Bonjour le monde' },
      { order_index: 1, source_line_ids: ['L001'], source_text: 'Bonjour le monde' },
    ]);
    expect(coverage.duplicatedLineIds).toEqual(['L001']);
  });

  it('detects a block referencing a source line id that does not exist', () => {
    const lines = toSourceLines('Bonjour');
    const coverage = checkCoverage(lines, [{ order_index: 0, source_line_ids: ['L999'], source_text: 'Bonjour' }]);
    expect(coverage.invalidLineReferences).toEqual(['L999']);
  });

  it('allows harmless whitespace differences between source_text and the referenced line', () => {
    const lines = toSourceLines('Bonjour   le monde');
    const coverage = checkCoverage(lines, [{ order_index: 0, source_line_ids: ['L001'], source_text: 'Bonjour le monde' }]);
    expect(coverage.alteredText).toEqual([]);
  });

  it('flags source_text that genuinely diverges from the referenced line wording', () => {
    const lines = toSourceLines('Bonjour le monde');
    const coverage = checkCoverage(lines, [{ order_index: 0, source_line_ids: ['L001'], source_text: 'Salut tout le monde' }]);
    expect(coverage.alteredText).toHaveLength(1);
  });

  it('flags a block that references earlier lines out of order relative to the previous block', () => {
    const lines = toSourceLines('A\nB\nC');
    const coverage = checkCoverage(lines, [
      { order_index: 0, source_line_ids: ['L003'], source_text: 'C' },
      { order_index: 1, source_line_ids: ['L001'], source_text: 'A' },
    ]);
    expect(coverage.orderingIssues).toHaveLength(1);
  });
});
