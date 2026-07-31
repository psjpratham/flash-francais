const STORAGE_KEY = 'ff-theme';

export type Theme = 'light' | 'dark';

function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

/**
 * The `<html data-theme>` attribute is already set by an inline script in
 * index.html's `<head>` (before first paint, to avoid a light-mode flash) —
 * this just syncs the toggle switch's checked state to whatever that
 * resolved to, and wires 'change' (the switch is a real checkbox input,
 * styled via CSS as a sliding track+knob — not a plain button that
 * relabels itself) to flip + persist it. Never re-derives the initial
 * value itself, so there's exactly one source of truth for "what theme
 * did we start in".
 */
export function initTheme(toggle: HTMLInputElement): void {
  toggle.checked = currentTheme() === 'dark';
  toggle.addEventListener('change', () => {
    const next: Theme = toggle.checked ? 'dark' : 'light';
    localStorage.setItem(STORAGE_KEY, next);
    document.documentElement.setAttribute('data-theme', next);
  });
}
