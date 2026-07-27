// Safe rendering for the controlled rich-text model (RichTextContent) — a
// fixed small set of node/span kinds, never raw HTML or markdown from the
// model. Every string is passed through esc(); the only "markup" that can
// ever appear is the fixed wrapper tags this file itself writes.

import type { RichTextContent, RichTextNode, RichTextSpan } from '../types';
import { esc } from './dom';

const PRON_ICON_HTML = ` <button type="button" class="pron-icon" data-pron-play title="Play pronunciation">🔊</button>`;

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

/** Same as renderRichText, but appends a non-functional pronunciation icon after each non-heading node — phrase/sentence granularity, never per word. */
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
    const inner = (node.spans ?? []).map(renderSpan).join('');
    const icon = node.type === 'heading' ? '' : PRON_ICON_HTML;
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

/** Renders plain (legacy-shape) text as sentence-level spans, each optionally followed by a non-functional pronunciation icon. */
export function renderTextWithPronunciation(text: string, enabled: boolean): string {
  const sentences = splitSentences(text);
  if (!sentences.length) return '';
  if (!enabled) return `<p>${sentences.map((s) => esc(s)).join(' ')}</p>`;
  return `<p>${sentences.map((s) => `<span class="read-sentence">${esc(s)}${PRON_ICON_HTML}</span>`).join(' ')}</p>`;
}
