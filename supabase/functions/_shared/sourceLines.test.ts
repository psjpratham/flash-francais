import { describe, expect, it } from 'vitest';
import { formatNumberedLines, isMeaningfulLine, normalizeForComparison, toSourceLines } from './sourceLines';

describe('toSourceLines', () => {
  it('numbers every line starting at L001, including blank lines', () => {
    const lines = toSourceLines('Bonjour\n\nComment ça va ?');
    expect(lines).toEqual([
      { id: 'L001', text: 'Bonjour' },
      { id: 'L002', text: '' },
      { id: 'L003', text: 'Comment ça va ?' },
    ]);
  });

  it('normalizes CRLF to LF before splitting', () => {
    const lines = toSourceLines('a\r\nb\r\nc');
    expect(lines.map((l) => l.text)).toEqual(['a', 'b', 'c']);
  });

  it('pads ids to three digits', () => {
    const lines = toSourceLines(Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n'));
    expect(lines[9].id).toBe('L010');
  });
});

describe('isMeaningfulLine', () => {
  it('treats whitespace-only lines as not meaningful', () => {
    expect(isMeaningfulLine({ id: 'L001', text: '   ' })).toBe(false);
    expect(isMeaningfulLine({ id: 'L001', text: '' })).toBe(false);
    expect(isMeaningfulLine({ id: 'L001', text: 'Leçon 1' })).toBe(true);
  });
});

describe('formatNumberedLines', () => {
  it('formats as [Lxxx] text per line', () => {
    const out = formatNumberedLines([
      { id: 'L001', text: 'Bonjour' },
      { id: 'L002', text: 'Au revoir' },
    ]);
    expect(out).toBe('[L001] Bonjour\n[L002] Au revoir');
  });
});

describe('normalizeForComparison', () => {
  it('collapses whitespace and trims, but does not change wording', () => {
    expect(normalizeForComparison('  Bonjour   le\n\nmonde  ')).toBe('Bonjour le monde');
    expect(normalizeForComparison('Bonjour')).not.toBe(normalizeForComparison('Bonjour !'));
  });
});
