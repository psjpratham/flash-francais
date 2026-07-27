// Safe renderer for composed_activity blocks. The model may only compose
// from COMPOSED_PRIMITIVE_TYPES (types/index.ts) — never arbitrary
// component names, HTML, CSS, or JS. This validates the whole tree
// structurally before rendering anything: an invalid, oversized, or
// unrecognized node fails the entire tree, which falls back to plain text
// rather than rendering partial/broken markup or ever treating model JSON
// as HTML.

import type { ComposedNode, PageBlock } from '../types';
import { COMPOSED_PRIMITIVE_TYPES } from '../types';
import { esc } from './dom';
import { renderRichText } from './richText';

const ALLOWED = new Set<string>(COMPOSED_PRIMITIVE_TYPES);
const MAX_DEPTH = 6;
const MAX_NODES = 200;

function isValidNode(raw: unknown, depth: number, counter: { n: number }): raw is ComposedNode {
  if (depth > MAX_DEPTH) return false;
  counter.n++;
  if (counter.n > MAX_NODES) return false;
  if (typeof raw !== 'object' || raw === null) return false;
  const n = raw as Record<string, unknown>;
  if (typeof n.type !== 'string' || !ALLOWED.has(n.type)) return false;
  if (n.children !== undefined) {
    if (!Array.isArray(n.children)) return false;
    for (const child of n.children) {
      if (!isValidNode(child, depth + 1, counter)) return false;
    }
  }
  return true;
}

/** Structurally validates a composed_activity root — returns null (safe fallback) unless the whole tree is composed of allowlisted primitives. */
export function validateComposedRoot(raw: unknown): ComposedNode | null {
  const counter = { n: 0 };
  if (!isValidNode(raw, 0, counter)) return null;
  return raw as ComposedNode;
}

function renderOption(node: ComposedNode, groupType: 'radio' | 'checkbox', name: string): string {
  const id = `${name}-${esc(node.id ?? node.label ?? Math.random().toString(36).slice(2))}`;
  return `<label class="composed-option"><input type="${groupType}" name="${esc(name)}" id="${id}"><span>${esc(node.label ?? '')}</span></label>`;
}

export function renderComposedNode(node: ComposedNode, blockId: string): string {
  switch (node.type) {
    case 'text':
      return `<span class="composed-text">${esc(node.text ?? '')}</span>`;
    case 'rich_text':
      return renderRichText(node.richText);
    case 'label':
      return `<div class="composed-label">${esc(node.text ?? node.label ?? '')}</div>`;
    case 'divider':
      return `<hr class="composed-divider">`;
    case 'badge':
      return `<span class="composed-badge">${esc(node.text ?? node.label ?? '')}</span>`;
    case 'spacer':
      return `<div class="composed-spacer"></div>`;
    case 'short_input':
      return `<input type="text" class="composed-input" data-composed-field="${esc(blockId)}-${esc(node.id ?? '')}" placeholder="${esc(node.placeholder ?? '')}">`;
    case 'long_input':
      return `<textarea class="composed-input composed-textarea" rows="3" data-composed-field="${esc(blockId)}-${esc(node.id ?? '')}" placeholder="${esc(node.placeholder ?? '')}"></textarea>`;
    case 'radio_group':
      return `<div class="composed-option-group">${(node.children ?? []).map((ch) => renderOption(ch, 'radio', `${blockId}-${node.id ?? 'radio'}`)).join('')}</div>`;
    case 'checkbox_group':
      return `<div class="composed-option-group">${(node.children ?? []).map((ch) => renderOption(ch, 'checkbox', `${blockId}-${node.id ?? 'checkbox'}`)).join('')}</div>`;
    case 'option':
      return ''; // rendered only via its parent radio_group/checkbox_group
    case 'table': {
      const headHtml = node.headers?.length ? `<tr>${node.headers.map((h) => `<td><strong>${esc(h)}</strong></td>`).join('')}</tr>` : '';
      const rowsHtml = (node.rows ?? []).map((row) => `<tr>${row.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('');
      return `<table class="p-tbl composed-table">${headHtml}${rowsHtml}</table>`;
    }
    case 'activity_audio_control':
      return `<div class="read-activity-audio unresolved"><span class="read-activity-audio-icon">🔈</span><span class="read-activity-audio-label">${esc(node.label ?? node.text ?? 'Audio')}</span></div>`;
    case 'pronunciation_control':
      return `<button type="button" class="pron-icon" data-pron-play title="Play pronunciation">🔊 ${esc(node.label ?? '')}</button>`;
    case 'row':
      return `<div class="composed-row">${(node.children ?? []).map((ch) => renderComposedNode(ch, blockId)).join('')}</div>`;
    case 'column':
      return `<div class="composed-column">${(node.children ?? []).map((ch) => renderComposedNode(ch, blockId)).join('')}</div>`;
    case 'group':
      return `<div class="composed-group">${(node.children ?? []).map((ch) => renderComposedNode(ch, blockId)).join('')}</div>`;
    default:
      return '';
  }
}

/** Renders a composed_activity block's root, or a safe plain-text fallback (never crashes, never treats unrecognized JSON as markup) when the tree fails validation. */
export function renderComposedActivity(block: PageBlock): string {
  const content = block.content as { root?: unknown } | null | undefined;
  const validated = content?.root ? validateComposedRoot(content.root) : null;
  if (!validated) {
    return `<div class="composed-fallback"><p>${esc(block.source_text || 'This activity could not be displayed in its designed format.')}</p></div>`;
  }
  return `<div class="composed-root">${renderComposedNode(validated, block.id)}</div>`;
}
