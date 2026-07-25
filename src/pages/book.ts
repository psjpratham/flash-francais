import { listBookLessons } from '../lib/book';
import type { BookBlock, BookDocumentBlock, BookLesson, BookSection } from '../types';
import { $, esc, errMsg, toast } from '../lib/dom';
import { playCardAudio } from '../lib/audioPlayer';

// Adjust this if your image folder structure differs.
const IMAGE_BASE_PATH = '/unit3-images';

export interface BookListDeps {
  onOpenLesson: (lesson: BookLesson) => void;
  onBack: () => void;
}

/** Lesson list: fetches book_lessons once and shows each as a card. */
export async function renderBookList(container: HTMLElement, deps: BookListDeps): Promise<void> {
  container.innerHTML = `
    <div class="wrap">
      <button class="back-link" id="backBtn">← Deck</button>
      <div class="page-h"><h1>📖 Read this unit</h1><p>Lessons in book order.</p></div>
      <div id="lessonListBody"><div class="stats-loading">Loading…</div></div>
    </div>`;
  $(container, '#backBtn').addEventListener('click', deps.onBack);

  let lessons: BookLesson[] = [];
  try {
    lessons = await listBookLessons();
  } catch (e) {
    const el = document.getElementById('lessonListBody');
    if (el) el.innerHTML = `<div class="panelbox">Could not load lessons: ${esc(errMsg(e))}</div>`;
    toast('Could not load lessons: ' + errMsg(e));
    return;
  }

  const el = document.getElementById('lessonListBody');
  if (!el) return; // navigated away while loading
  if (!lessons.length) {
    el.innerHTML = `<div class="panelbox">No lessons yet.</div>`;
    return;
  }
  el.innerHTML = `<div class="grid">${lessons
    .map(
      (l) => `
    <div class="course" data-id="${l.id}">
      <div class="course-top">
        <div class="course-badge">📘</div>
        <div><div class="course-title">${esc(l.lesson_number ? `Leçon ${l.lesson_number} — ${l.title}` : l.title)}</div><div class="course-meta">${esc(l.subtitle || '')}</div></div>
      </div>
    </div>`,
    )
    .join('')}</div>`;
  el.querySelectorAll<HTMLElement>('.course[data-id]').forEach((card) => {
    card.addEventListener('click', () => {
      const lesson = lessons.find((l) => l.id === card.dataset.id);
      if (lesson) deps.onOpenLesson(lesson);
    });
  });
}

export interface BookReaderDeps {
  onBack: () => void;
}

/** Reader shell: renders one lesson's sections/blocks top to bottom. All blocks are placeholders for now. */
export function renderBookReader(container: HTMLElement, lesson: BookLesson, deps: BookReaderDeps): void {
  container.innerHTML = `
    <div class="wrap">
      <button class="back-link" id="backBtn">← Lessons</button>
      <div class="page-h">
        <h1>${esc(lesson.lesson_number ? `Leçon ${lesson.lesson_number}` : lesson.title)}</h1>
        <p>${esc(lesson.lesson_number ? lesson.title : '')} ${esc(lesson.subtitle || '')}</p>
      </div>
      <div id="bookSections"></div>
    </div>`;
  $(container, '#backBtn').addEventListener('click', deps.onBack);
  const sectionsEl = $(container, '#bookSections');
  sectionsEl.innerHTML = lesson.content.sections.map(renderSection).join('');
  sectionsEl.querySelectorAll<HTMLButtonElement>('.chip.audio[data-audio]').forEach((btn) => {
    btn.addEventListener('click', () => playCardAudio(btn.dataset.audio!, btn));
  });
}

function renderSection(section: BookSection): string {
  return `
    <div class="book-section">
      <div class="book-section-h">${esc(section.title)}</div>
      <div class="book-blocks">${section.blocks.map(renderBlock).join('')}</div>
    </div>`;
}

function renderBlock(b: BookBlock): string {
  if (b.type === 'document') return renderDocumentBlock(b);
  return renderBlockPlaceholder(b);
}

// ---------- document blocks ----------

function parseSpeakerLines(body: string): { speaker: string | null; text: string }[] {
  return body
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const m = l.match(/^([^:]{1,28}?)\s*:\s*(.+)$/);
      return m ? { speaker: m[1].trim(), text: m[2] } : { speaker: null, text: l };
    });
}

function renderSocialPostDoc(b: BookDocumentBlock, imgTag: string): string {
  const posts = parseSpeakerLines(b.body);
  return `<div class="ig-card">
    <div class="ig-top">📷 <b>Instagram</b></div>
    ${imgTag ? `<div class="ig-photo">${imgTag}</div>` : '<div class="ig-photo ig-photo-placeholder"></div>'}
    <div class="ig-icons">♥ &nbsp; 💬 &nbsp; ↗</div>
    <div class="ig-caption">${posts.map((p) => `<div>${p.speaker ? `<b>${esc(p.speaker)}</b> ` : ''}${esc(p.text)}</div>`).join('')}</div>
  </div>`;
}

/** Fake URL for the browser-chrome bar, derived from the doc title. */
function fakeUrl(title: string): string {
  return title.toLowerCase().replace(/\s+/g, '');
}

function renderForumPostDoc(b: BookDocumentBlock): string {
  const lines = b.body.split('\n').filter(Boolean);
  return `<div class="forum-card">
    <div class="browser-bar">🔒 ${esc(fakeUrl(b.title))}</div>
    <div class="forum-title">${esc(b.title)}</div>
    <div class="forum-body">${lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>
  </div>`;
}

function renderWebpageDoc(b: BookDocumentBlock): string {
  return `<div class="webpage-card">
    <div class="browser-bar">🔒 ${esc(fakeUrl(b.title))}</div>
    <div class="webpage-body">${esc(b.body).replace(/\n/g, '<br>')}</div>
  </div>`;
}

function renderEmailDoc(b: BookDocumentBlock): string {
  const parts = b.body.split('\n\n');
  const header = parts[0].split('\n').filter(Boolean);
  const rest = parts.slice(1).join('\n\n');
  return `<div class="email-card">
    <div class="email-header">${header.map((h) => `<div>${esc(h)}</div>`).join('')}</div>
    <div class="email-body">${esc(rest).replace(/\n/g, '<br>')}</div>
  </div>`;
}

function renderDialogueDoc(b: BookDocumentBlock): string {
  const lines = parseSpeakerLines(b.body);
  const sideFor: Record<string, 'left' | 'right'> = {};
  let nextSide = 0;
  return `<div class="chat-card">${lines
    .map((l) => {
      if (l.speaker && !(l.speaker in sideFor)) {
        sideFor[l.speaker] = nextSide % 2 === 0 ? 'left' : 'right';
        nextSide++;
      }
      const side = l.speaker ? sideFor[l.speaker] : 'left';
      return `<div class="chat-bubble ${side}">${l.speaker ? `<div class="chat-name">${esc(l.speaker)}</div>` : ''}${esc(l.text)}</div>`;
    })
    .join('')}</div>`;
}

function renderCaptionedPhotosDoc(b: BookDocumentBlock, imgTag: string): string {
  return `<div class="captioned-card">${imgTag}<div class="p-text" style="margin-top:8px">${esc(b.body).replace(/\n/g, '<br>')}</div></div>`;
}

function renderVoicemailDoc(b: BookDocumentBlock): string {
  return `<div class="voicemail-card"><div class="voicemail-icon">📞</div><div class="p-text">${esc(b.body).replace(/\n/g, '<br>')}</div></div>`;
}

function renderDocumentBlock(b: BookDocumentBlock): string {
  const audioBtn = b.audio ? `<button class="chip audio" data-audio="${esc(b.audio)}">🔊 Audio</button>` : '';
  const imgTag = b.image ? `<img class="book-doc-image" src="${IMAGE_BASE_PATH}/${esc(b.image)}" alt="">` : '';
  let bodyHTML: string;
  if (b.docType === 'social-post') bodyHTML = renderSocialPostDoc(b, imgTag);
  else if (b.docType === 'forum-post') bodyHTML = renderForumPostDoc(b);
  else if (b.docType === 'email') bodyHTML = renderEmailDoc(b);
  else if (b.docType === 'dialogue') bodyHTML = renderDialogueDoc(b);
  else if (b.docType === 'webpage') bodyHTML = renderWebpageDoc(b);
  else if (b.docType === 'captioned-photos') bodyHTML = renderCaptionedPhotosDoc(b, imgTag);
  else if (b.docType === 'audio-message') bodyHTML = renderVoicemailDoc(b);
  else
    bodyHTML = `<div class="book-doc">${imgTag}<div class="book-doc-title">${esc(b.title)}</div><div class="book-doc-body">${esc(b.body).replace(/\n/g, '<br>')}</div></div>`;

  return `<div class="book-doc-wrap">
    <div class="book-doc-h"><span class="book-doc-type">${esc(b.docType)}</span>${audioBtn}</div>
    ${bodyHTML}
  </div>`;
}

function blockBadge(b: BookBlock): string {
  if (b.type === 'document') return `document · ${b.docType}`;
  if (b.type === 'activity') return `activity · ${b.interaction}`;
  return b.type;
}

function blockTitle(b: BookBlock): string {
  return b.type === 'activity' ? b.prompt : b.title;
}

function blockBody(b: BookBlock): string {
  if (b.type === 'document' || b.type === 'culture') return b.body;
  if (b.type === 'reference') return Array.isArray(b.body) ? b.body.map((row) => row.join(' | ')).join('\n') : b.body;
  // activity: no single "body" field across interaction types — dump the rest as a placeholder
  const { type: _type, id: _id, prompt: _prompt, note, sourceRef, audio, interaction: _interaction, ...rest } = b;
  void _type;
  void _id;
  void _prompt;
  void _interaction;
  const extras = { ...(note ? { note } : {}), ...(sourceRef ? { sourceRef } : {}), ...(audio ? { audio } : {}), ...rest };
  return Object.keys(extras).length ? JSON.stringify(extras, null, 2) : '(no additional content)';
}

/** Placeholder rendering for every block type — real per-type rendering is a later slice. */
function renderBlockPlaceholder(b: BookBlock): string {
  const title = blockTitle(b);
  return `
    <div class="book-doc">
      <div class="book-doc-h"><span class="book-doc-type">${esc(blockBadge(b))}</span></div>
      ${title ? `<div class="book-doc-title">${esc(title)}</div>` : ''}
      <div class="book-doc-body">${esc(blockBody(b))}</div>
    </div>`;
}
