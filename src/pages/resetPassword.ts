import { updatePassword } from '../lib/auth';
import { $, errMsg, esc } from '../lib/dom';

export interface ResetPasswordDeps {
  /** Fired once the new password is saved — caller should drop back into the normal app view. */
  onDone: () => void;
}

/** Shown when the user lands back on the app via a password-reset email link (see index.html's `type=recovery` detection and main.ts's pendingPasswordRecovery handling). */
export function renderResetPassword(container: HTMLElement, deps: ResetPasswordDeps): void {
  let error: string | null = null;
  let saving = false;

  function render(): void {
    container.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card">
          <h1>Set a new password</h1>
          <p>Choose a new password for your account.</p>
          ${error ? `<div class="auth-err">${esc(error)}</div>` : ''}
          <form id="resetForm">
            <div class="field">
              <label for="resetPass">New password</label>
              <input id="resetPass" type="password" autocomplete="new-password" required minlength="6" ${saving ? 'disabled' : ''}>
            </div>
            <div class="field">
              <label for="resetPass2">Confirm password</label>
              <input id="resetPass2" type="password" autocomplete="new-password" required minlength="6" ${saving ? 'disabled' : ''}>
            </div>
            <button class="btn-primary" id="resetBtn" type="submit" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save new password'}</button>
          </form>
        </div>
      </div>`;

    $(container, '#resetForm').addEventListener('submit', (e) => {
      e.preventDefault();
      void submit();
    });
  }

  async function submit(): Promise<void> {
    const p1 = $<HTMLInputElement>(container, '#resetPass').value;
    const p2 = $<HTMLInputElement>(container, '#resetPass2').value;
    error = null;

    if (p1 !== p2) {
      error = 'Passwords do not match.';
      render();
      return;
    }

    saving = true;
    render();
    try {
      await updatePassword(p1);
      deps.onDone();
    } catch (e) {
      error = errMsg(e);
      saving = false;
      render();
    }
  }

  render();
}
