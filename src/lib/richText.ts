// Safe rendering for the controlled rich-text model (RichTextContent) — a
// fixed small set of node/span kinds, never raw HTML or markdown from the
// model. Every string is passed through esc(); the only "markup" that can
// ever appear is the fixed wrapper tags this file itself writes.

import type { RichTextContent, RichTextNode, RichTextSpan } from '../types';
import { esc } from './dom';

/** Same markup/classes readModeRenderers.ts's pronIconHTML produces (duplicated, not imported — that file already imports from this one, so importing back would be circular); wirePronunciationIcons wires either one identically since both just look for [data-pron-play]. Carries the actual segment text via data-pron-text, unlike the old version of this icon which rendered with no payload at all and silently did nothing when clicked. */
function pronIconHTML(text: string): string {
  return ` <button type="button" class="pron-icon" data-pron-play data-pron-text="${esc(text)}" title="Play pronunciation"><span class="pron-icon-emoji">🔊</span><span class="pron-icon-spinner"></span></button>`;
}

function renderSpan(span: RichTextSpan): string {
  let html = esc(span.text);
  if (span.bold) html = `<strong>${html}</strong>`;
  if (span.italic) html = `<em>${html}</em>`;
  return html;
}

/** Renders a controlled rich-text node list as safe HTML. */
export function renderRichText(content: RichTextContent | null | undefined): string {
  const nodes = content?.nodes ?? [];
  if (!nodes.length) return '';
  const out: string[] = [];
  let listBuf: string[] = [];
  const flushList = () => {
    if (listBuf.length) {
      out.push(`<ul class="rt-list">${listBuf.join('')}</ul>`);
      listBuf = [];
    }
  };
  for (const node of nodes) {
    const inner = (node.spans ?? []).map(renderSpan).join('');
    if (node.type === 'list_item') {
      listBuf.push(`<li>${inner}</li>`);
      continue;
    }
    flushList();
    if (node.type === 'heading') out.push(`<div class="rt-heading">${inner}</div>`);
    else out.push(`<p>${inner}</p>`);
  }
  flushList();
  return out.join('');
}

/** Same as renderRichText, but appends a real pronunciation icon (speaking that node's own text) after each non-heading node — phrase/sentence granularity, never per word. */
export function renderRichTextPronounced(content: RichTextContent | null | undefined, enabled: boolean): string {
  if (!enabled) return renderRichText(content);
  const nodes = content?.nodes ?? [];
  if (!nodes.length) return '';
  const out: string[] = [];
  let listBuf: string[] = [];
  const flushList = () => {
    if (listBuf.length) {
      out.push(`<ul class="rt-list">${listBuf.join('')}</ul>`);
      listBuf = [];
    }
  };
  for (const node of nodes) {
    const spans = node.spans ?? [];
    const inner = spans.map(renderSpan).join('');
    const plainText = spans.map((s) => s.text).join('');
    const icon = node.type === 'heading' || !plainText.trim() ? '' : pronIconHTML(plainText);
    if (node.type === 'list_item') {
      listBuf.push(`<li>${inner}${icon}</li>`);
      continue;
    }
    flushList();
    if (node.type === 'heading') out.push(`<div class="rt-heading">${inner}</div>`);
    else out.push(`<p>${inner}${icon}</p>`);
  }
  flushList();
  return out.join('');
}

export function plainTextFromRichText(content: RichTextContent | null | undefined): string {
  return (content?.nodes ?? []).map((n: RichTextNode) => (n.spans ?? []).map((s) => s.text).join('')).join(' ');
}

const SENTENCE_RE = /[^.!?…]+[.!?…]*/g;

/** Splits plain text into sentence-ish chunks for phrase-level pronunciation icons — never per word. */
export function splitSentences(text: string): string[] {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return [];
  const matches = trimmed.match(SENTENCE_RE);
  return matches ? matches.map((s) => s.trim()).filter(Boolean) : [trimmed];
}

/** Renders plain (legacy-shape) text as sentence-level spans, each optionally followed by a real pronunciation icon (speaking that sentence). */
export function renderTextWithPronunciation(text: string, enabled: boolean): string {
  const sentences = splitSentences(text);
  if (!sentences.length) return '';
  if (!enabled) return `<p>${sentences.map((s) => esc(s)).join(' ')}</p>`;
  return `<p>${sentences.map((s) => `<span class="read-sentence">${esc(s)}${pronIconHTML(s)}</span>`).join(' ')}</p>`;
}
