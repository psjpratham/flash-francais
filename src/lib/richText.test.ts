import { describe, expect, it } from 'vitest';
import { plainTextFromRichText, renderRichText, renderRichTextPronounced, renderTextWithPronunciation, splitSentences } from './richText';

describe('renderRichText', () => {
  it('escapes text and applies only bold/italic — never raw HTML from spans', () => {
    const html = renderRichText({ nodes: [{ type: 'paragraph', spans: [{ text: '<b>x</b>', bold: true }] }] });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(html).toContain('<strong>');
    expect(html).not.toContain('<b>x</b>');
  });

  it('groups consecutive list_item nodes into a single <ul>', () => {
    const html = renderRichText({
      nodes: [
        { type: 'list_item', spans: [{ text: 'one' }] },
        { type: 'list_item', spans: [{ text: 'two' }] },
        { type: 'paragraph', spans: [{ text: 'after' }] },
      ],
    });
    expect(html).toBe('<ul class="rt-list"><li>one</li><li>two</li></ul><p>after</p>');
  });

  it('returns empty string for empty/missing content', () => {
    expect(renderRichText(undefined)).toBe('');
    expect(renderRichText({ nodes: [] })).toBe('');
  });
});

describe('renderRichTextPronounced', () => {
  it('appends a pronunciation icon after non-heading nodes only when enabled', () => {
    const content = {
      nodes: [
        { type: 'heading' as const, spans: [{ text: 'Title' }] },
        { type: 'paragraph' as const, spans: [{ text: 'Body' }] },
      ],
    };
    const withIcons = renderRichTextPronounced(content, true);
    const withoutIcons = renderRichTextPronounced(content, false);
    expect(withIcons).toContain('data-pron-play');
    expect(withIcons.match(/data-pron-play/g)?.length).toBe(1); // not on the heading
    expect(withoutIcons).not.toContain('data-pron-play');
  });
});

describe('plainTextFromRichText', () => {
  it('joins all span text with no markup', () => {
    expect(
      plainTextFromRichText({
        nodes: [
          { type: 'paragraph', spans: [{ text: 'Hello' }, { text: ' world' }] },
        ],
      }),
    ).toBe('Hello world');
  });
});

describe('splitSentences', () => {
  it('splits on sentence-ending punctuation, not per word', () => {
    expect(splitSentences('Bonjour. Comment ça va ? Très bien !')).toEqual(['Bonjour.', 'Comment ça va ?', 'Très bien !']);
  });

  it('returns an empty array for blank input', () => {
    expect(splitSentences('   ')).toEqual([]);
  });
});

describe('renderTextWithPronunciation', () => {
  it('adds one icon per sentence, never per word, only when enabled', () => {
    const html = renderTextWithPronunciation('Un. Deux.', true);
    expect(html.match(/data-pron-play/g)?.length).toBe(2);
    expect(renderTextWithPronunciation('Un. Deux.', false)).not.toContain('data-pron-play');
  });

  it('escapes the sentence text', () => {
    expect(renderTextWithPronunciation('<b>x</b>.', false)).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});
