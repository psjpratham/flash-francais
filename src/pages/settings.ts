import { deleteMyAccount, updatePassword } from '../lib/auth';
import { $, errMsg, esc, toast } from '../lib/dom';

export interface SettingsDeps {
  onBack: () => void;
  currentUserEmail: string;
  /** Fired after the account is successfully deleted — caller should sign out and return to the login screen. */
  onAccountDeleted: () => void;
}

export function renderSettings(container: HTMLElement, deps: SettingsDeps): void {
  let pwSaving = false;
  let pwError: string | null = null;
  let pwSuccess = false;

  let showDeleteConfirm = false;
  let deleteConfirmText = '';
  let deleting = false;
  let deleteError: string | null = null;

  function render(): void {
    container.innerHTML = `
      <div class="wrap">
        <button class="back-link" id="backBtn">← Back</button>
        <div class="page-h">
          <h1>Settings</h1>
          <p>${esc(deps.currentUserEmail)}</p>
        </div>

        <div class="panelbox">
          <h3>Change password</h3>
          ${pwError ? `<div class="auth-err">${esc(pwError)}</div>` : ''}
          ${pwSuccess ? `<div class="auth-ok">Password updated.</div>` : ''}
          <form id="pwForm">
            <div class="field">
              <label for="newPass">New password</label>
              <input id="newPass" type="password" autocomplete="new-password" required minlength="6" ${pwSaving ? 'disabled' : ''}>
            </div>
            <div class="field">
              <label for="newPass2">Confirm new password</label>
              <input id="newPass2" type="password" autocomplete="new-password" required minlength="6" ${pwSaving ? 'disabled' : ''}>
            </div>
            <button class="btn-primary" id="pwBtn" type="submit" style="width:auto" ${pwSaving ? 'disabled' : ''}>${pwSaving ? 'Saving…' : 'Update password'}</button>
          </form>
        </div>

        <div class="panelbox">
          <h3>Delete account</h3>
          <p style="font-size:13px;color:var(--ink-soft);margin-bottom:10px">
            This permanently deletes your account and everything in it: all your decks, cards, imports, and study history. This cannot be undone.
          </p>
          ${
            !showDeleteConfirm
              ? `<button class="btn-danger" id="startDeleteBtn">🗑 Delete my account</button>`
              : `
              ${deleteError ? `<div class="auth-err">${esc(deleteError)}</div>` : ''}
              <div class="field">
                <label>Type your email (${esc(deps.currentUserEmail)}) to confirm</label>
                <input id="deleteConfirmInput" placeholder="${esc(deps.currentUserEmail)}" value="${esc(deleteConfirmText)}" ${deleting ? 'disabled' : ''}>
              </div>
              <div class="row">
                <button class="btn-danger" id="confirmDeleteBtn" ${deleteConfirmText.trim() === deps.currentUserEmail && !deleting ? '' : 'disabled'}>${deleting ? 'Deleting…' : 'Delete permanently'}</button>
                <button class="btn-sec" id="cancelDeleteBtn" ${deleting ? 'disabled' : ''}>Cancel</button>
              </div>`
          }
        </div>
      </div>`;

    $(container, '#backBtn').addEventListener('click', deps.onBack);

    $(container, '#pwForm').addEventListener('submit', (e) => {
      e.preventDefault();
      void submitPassword();
    });

    if (!showDeleteConfirm) {
      $(container, '#startDeleteBtn').addEventListener('click', () => {
        showDeleteConfirm = true;
        deleteConfirmText = '';
        deleteError = null;
        render();
      });
      return;
    }

    const input = $<HTMLInputElement>(container, '#deleteConfirmInput');
    const confirmBtn = $<HTMLButtonElement>(container, '#confirmDeleteBtn');
    input.addEventListener('input', () => {
      deleteConfirmText = input.value;
      confirmBtn.disabled = deleteConfirmText.trim() !== deps.currentUserEmail;
    });
    $(container, '#cancelDeleteBtn').addEventListener('click', () => {
      showDeleteConfirm = false;
      render();
    });
    $(container, '#confirmDeleteBtn').addEventListener('click', () => void doDelete());
  }

  async function submitPassword(): Promise<void> {
    const p1 = $<HTMLInputElement>(container, '#newPass').value;
    const p2 = $<HTMLInputElement>(container, '#newPass2').value;
    pwError = null;
    pwSuccess = false;

    if (p1 !== p2) {
      pwError = 'Passwords do not match.';
      render();
      return;
    }

    pwSaving = true;
    render();
    try {
      await updatePassword(p1);
      pwSaving = false;
      pwSuccess = true;
      render();
    } catch (e) {
      pwError = errMsg(e);
      pwSaving = false;
      render();
    }
  }

  async function doDelete(): Promise<void> {
    if (deleteConfirmText.trim() !== deps.currentUserEmail) return;
    deleting = true;
    deleteError = null;
    render();
    try {
      await deleteMyAccount();
      toast('Account deleted.');
      deps.onAccountDeleted();
    } catch (e) {
      deleteError = 'Could not delete account: ' + errMsg(e);
      deleting = false;
      render();
    }
  }

  render();
}
