import { signIn, signUp, getSession } from '../lib/auth';
import { $, errMsg, esc } from '../lib/dom';

type Mode = 'signin' | 'signup';

/** Renders the sign-in/sign-up card into `container` and calls `onAuthenticated` once a session exists. */
export function renderAuth(container: HTMLElement, onAuthenticated: () => void): void {
  let mode: Mode = 'signin';
  let error: string | null = null;
  let info: string | null = null;

  function render(): void {
    container.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <h1>${mode === 'signin' ? 'Welcome back' : 'Create your account'}</h1>
          <p>${mode === 'signin' ? 'Sign in to study your decks.' : 'Sign up to start building your own decks.'}</p>
          ${error ? `<div class="auth-err">${esc(error)}</div>` : ''}
          ${info ? `<div class="auth-ok">${esc(info)}</div>` : ''}
          <form id="authForm">
            <div class="field">
              <label for="authEmail">Email</label>
              <input id="authEmail" type="email" autocomplete="email" required>
            </div>
            <div class="field">
              <label for="authPass">Password</label>
              <input id="authPass" type="password" autocomplete="${mode === 'signin' ? 'current-password' : 'new-password'}" required minlength="6">
            </div>
            <button class="btn-primary" id="authBtn" type="submit">${mode === 'signin' ? 'Sign in' : 'Sign up'}</button>
          </form>
          <div class="auth-toggle">
            ${
              mode === 'signin'
                ? `No account? <b id="authToggle">Sign up</b>`
                : `Already have one? <b id="authToggle">Sign in</b>`
            }
          </div>
        </div>
      </div>`;

    $(container, '#authToggle').addEventListener('click', () => {
      mode = mode === 'signin' ? 'signup' : 'signin';
      error = null;
      info = null;
      render();
    });

    $(container, '#authForm').addEventListener('submit', (e) => {
      e.preventDefault();
      void submit();
    });
  }

  async function submit(): Promise<void> {
    const email = $<HTMLInputElement>(container, '#authEmail').value.trim();
    const password = $<HTMLInputElement>(container, '#authPass').value;
    error = null;
    info = null;

    const btn = $<HTMLButtonElement>(container, '#authBtn');
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span>`;

    try {
      if (mode === 'signin') {
        await signIn(email, password);
        onAuthenticated();
        return;
      }

      await signUp(email, password);
      if (await getSession()) {
        onAuthenticated();
        return;
      }
      // email confirmation required: no session yet, so drop back to the sign-in form
      mode = 'signin';
      info = 'Check your email to confirm your account, then sign in.';
      render();
    } catch (e) {
      error = errMsg(e);
      render();
    }
  }

  render();
}
