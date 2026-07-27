import { toast } from './dom';

const ACCENT_CHARS = ['à', 'â', 'é', 'è', 'ê', 'ë', 'î', 'ï', 'ô', 'ù', 'û', 'ü', 'ç', 'œ', 'æ', 'À', 'É', 'È', 'Ç', 'Œ', '«', '»', '’', '—'];

let lastFocusedField: HTMLInputElement | HTMLTextAreaElement | null = null;

function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    const t = (el.getAttribute('type') || 'text').toLowerCase();
    return ['text', 'search', ''].includes(t);
  }
  return false;
}

function insertAccentChar(ch: string): void {
  const el = lastFocusedField;
  if (!el || !document.body.contains(el)) {
    toast('Cliquez d’abord dans un champ de texte');
    return;
  }
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + ch + el.value.slice(end);
  el.focus();
  el.selectionStart = el.selectionEnd = start + ch.length;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

let initialized = false;

/** Sets up the floating accent-keyboard FAB + popover once, globally, for the whole app. */
export function initAccentKeyboard(): void {
  if (initialized) return;
  initialized = true;

  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <button class="accent-fab" id="accentFab" title="Clavier français (glisser pour déplacer)">é</button>
    <div class="accent-panel" id="accentPanel">
      <div class="accent-panel-h">
        <span>Accents français</span>
        <button type="button" id="accentPanelClose">×</button>
      </div>
      <div class="accent-grid" id="accentGrid"></div>
      <div class="accent-hint">Cliquez dans un champ, puis sur une lettre</div>
    </div>`,
  );

  const fab = document.getElementById('accentFab') as HTMLButtonElement;
  const panel = document.getElementById('accentPanel') as HTMLDivElement;
  const grid = document.getElementById('accentGrid') as HTMLDivElement;

  document.addEventListener('focusin', (e) => {
    if (isTextField(e.target as Element)) lastFocusedField = e.target as HTMLInputElement | HTMLTextAreaElement;
  });

  grid.innerHTML = ACCENT_CHARS.map((c, i) => {
    const shortcutN = i < 9 ? i + 1 : i === 9 ? 0 : null;
    const hint = shortcutN !== null ? `<kbd class="accent-kbd">⌥${shortcutN}</kbd>` : '';
    return `<button type="button" data-ch="${c}">${c}${hint}</button>`;
  }).join('');
  grid.querySelectorAll<HTMLButtonElement>('button[data-ch]').forEach((btn) => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => insertAccentChar(btn.dataset.ch!));
  });

  document.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    const m = e.code.match(/^Digit([0-9])$/);
    if (!m) return;
    if (!isTextField(document.activeElement)) return;
    const n = parseInt(m[1], 10);
    const idx = n === 0 ? 9 : n - 1;
    if (idx < ACCENT_CHARS.length) {
      e.preventDefault();
      insertAccentChar(ACCENT_CHARS[idx]);
    }
  });

  function positionPanel(): void {
    const rect = fab.getBoundingClientRect();
    const panelW = panel.offsetWidth || 272;
    const panelH = panel.offsetHeight || 230;
    const gap = 10;
    let left = rect.left + rect.width / 2 - panelW / 2;
    left = Math.max(10, Math.min(left, window.innerWidth - panelW - 10));
    const spaceAbove = rect.top;
    const spaceBelow = window.innerHeight - rect.bottom;
    let top = spaceAbove >= panelH + gap || spaceAbove > spaceBelow ? rect.top - panelH - gap : rect.bottom + gap;
    top = Math.max(10, Math.min(top, window.innerHeight - panelH - 10));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  }

  function togglePanel(): void {
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    fab.classList.toggle('open', open);
    if (open) positionPanel();
  }

  document.getElementById('accentPanelClose')?.addEventListener('click', togglePanel);

  document.addEventListener('click', (e) => {
    if (!panel.classList.contains('open')) return;
    const target = e.target as Node;
    if (panel.contains(target) || fab.contains(target)) return;
    panel.classList.remove('open');
    fab.classList.remove('open');
  });

  // drag-to-reposition the FAB; a tap (no meaningful movement) toggles the panel instead
  let dragging = false;
  let moved = false;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;

  function place(left: number, top: number): void {
    const w = fab.offsetWidth;
    const h = fab.offsetHeight;
    left = Math.max(4, Math.min(left, window.innerWidth - w - 4));
    top = Math.max(4, Math.min(top, window.innerHeight - h - 4));
    fab.style.left = left + 'px';
    fab.style.top = top + 'px';
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
  }

  try {
    const saved = JSON.parse(localStorage.getItem('fc_accentfab_pos') || 'null');
    if (saved) place(saved.left, saved.top);
  } catch {
    /* ignore */
  }

  fab.addEventListener('pointerdown', (e) => {
    dragging = true;
    moved = false;
    startX = e.clientX;
    startY = e.clientY;
    const r = fab.getBoundingClientRect();
    origLeft = r.left;
    origTop = r.top;
    fab.setPointerCapture(e.pointerId);
  });
  fab.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
    if (!moved) return;
    place(origLeft + dx, origTop + dy);
    if (panel.classList.contains('open')) positionPanel();
  });
  function endDrag(): void {
    if (!dragging) return;
    dragging = false;
    if (moved) {
      const r = fab.getBoundingClientRect();
      localStorage.setItem('fc_accentfab_pos', JSON.stringify({ left: r.left, top: r.top }));
      positionPanel();
    } else {
      togglePanel();
    }
  }
  fab.addEventListener('pointerup', endDrag);
  fab.addEventListener('pointercancel', endDrag);
  window.addEventListener('resize', () => {
    if (panel.classList.contains('open')) positionPanel();
  });
}
