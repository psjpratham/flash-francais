export function $<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`Element not found: ${selector}`);
  return el;
}

export function esc(s: unknown): string {
  return (s == null ? '' : String(s)).replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );
}

/** Supabase throws plain {message, code, details, hint} objects, never real Error instances — String(e) on one of those gives "[object Object]", so those need their .message unwrapped explicitly, same as a real Error. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message;
  }
  return String(e);
}

/** Minimal, generic modal: appends an overlay+box to <body>, closes on backdrop click or Escape. Caller owns everything inside the box (querying, wiring, closing early via the returned `close`). `onClose` (optional) fires exactly once no matter which path closed it — backdrop click, Escape, or a caller-triggered `close()` — so a caller doesn't need to separately wire the backdrop/Escape paths to know the modal is gone. */
export function openModal(innerHTML: string, onClose?: () => void): { box: HTMLElement; close: () => void } {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box">${innerHTML}</div>`;
  document.body.appendChild(overlay);
  const box = overlay.querySelector<HTMLElement>('.modal-box')!;

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }
  function close(): void {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
  }
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);

  return { box, close };
}

/**
 * Non-blocking replacement for window.confirm — a native confirm() blocks
 * the JS thread waiting for a synchronous answer, which in some embedded/
 * webview hosts either never resolves or never actually paints, making the
 * whole page look permanently stuck loading with no visible dialog at all
 * (found the hard way: studyMode.ts's load() called window.confirm before
 * its first real render). This renders entirely in-page instead, so it can
 * never silently hang the caller.
 */
export function confirmDialog(message: string, confirmLabel = 'Yes', cancelLabel = 'No'): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    const { box, close } = openModal(
      `<p class="p-text" style="margin-bottom:16px">${esc(message)}</p>
      <div class="row" style="justify-content:flex-end">
        <button class="btn-sec" id="confirmDialogCancel">${esc(cancelLabel)}</button>
        <button class="btn-primary" style="width:auto" id="confirmDialogOk">${esc(confirmLabel)}</button>
      </div>`,
      () => resolve(result), // fires on ANY close path (button, backdrop click, Escape) — backdrop/Escape leave result at its false default, same as Cancel
    );
    box.querySelector('#confirmDialogOk')?.addEventListener('click', () => {
      result = true;
      close();
    });
    box.querySelector('#confirmDialogCancel')?.addEventListener('click', close);
  });
}

/** Non-blocking replacement for window.prompt — same rationale as confirmDialog above. Resolves the trimmed input, or null if cancelled/closed with nothing changed. */
export function promptDialog(title: string, defaultValue = '', confirmLabel = 'Save', cancelLabel = 'Cancel'): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const { box, close } = openModal(
      `<h3>${esc(title)}</h3>
      <div class="field"><input id="promptDialogInput" value="${esc(defaultValue)}"></div>
      <div class="row" style="justify-content:flex-end">
        <button class="btn-sec" id="promptDialogCancel">${esc(cancelLabel)}</button>
        <button class="btn-primary" style="width:auto" id="promptDialogOk">${esc(confirmLabel)}</button>
      </div>`,
      () => resolve(result),
    );
    const input = box.querySelector<HTMLInputElement>('#promptDialogInput')!;
    input.focus();
    input.select();
    const submit = (): void => {
      const v = input.value.trim();
      if (!v) return;
      result = v;
      close();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    box.querySelector('#promptDialogOk')?.addEventListener('click', submit);
    box.querySelector('#promptDialogCancel')?.addEventListener('click', close);
  });
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function toast(message: string): void {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}
