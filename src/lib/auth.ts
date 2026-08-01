import { supabase } from './supabase';
import type { Session } from '@supabase/supabase-js';
import type { Profile, UserRole } from '../types';

export async function getSession(): Promise<Session | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

/**
 * The current user's role, via their own profile row (RLS only allows
 * reading your own). Purely a UI-visibility signal now — it doesn't gate
 * any import/textbook-extraction capability anymore (see
 * 20260812000000_retire_admin_role.sql), only whether the admin-only
 * monitoring/diagnostics panel is shown.
 */
export async function getMyRole(): Promise<UserRole> {
  const { data, error } = await supabase.from('profiles').select('role').single();
  if (error) throw error;
  return data.role;
}

/** The current user's full profile row, including display_name (shown as author on their public decks, if any). */
export async function getMyProfile(): Promise<Profile> {
  const { data, error } = await supabase.from('profiles').select('*').single();
  if (error) throw error;
  return data;
}

/** Sets (or clears, with null/blank) the current user's display name. Goes through an RPC — there's no direct UPDATE policy on profiles, so a client can't touch `role`. */
export async function setMyDisplayName(displayName: string | null): Promise<Profile> {
  const { data, error } = await supabase.rpc('set_my_display_name', { p_display_name: displayName });
  if (error) throw error;
  return data;
}

export async function signIn(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}

export async function signUp(email: string, password: string): Promise<void> {
  // Explicit emailRedirectTo so the confirmation link lands back on whatever
  // origin the app is actually running on, rather than relying on the
  // dashboard's Site URL default (which is what sends users to Supabase's
  // bare, unstyled fallback page if it's stale or wrong). Must include Vite's
  // BASE_URL (e.g. '/flash-francais/') — on GitHub Pages project sites,
  // location.origin alone points at the bare github.io root, which has no
  // site published there and 404s.
  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: window.location.origin + import.meta.env.BASE_URL },
  });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/** Sends a password-reset email; clicking the link lands back on this origin with a recovery session (see index.html's `type=recovery` hash detection and main.ts's pendingPasswordRecovery handling). */
export async function resetPasswordForEmail(email: string): Promise<void> {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin + import.meta.env.BASE_URL,
  });
  if (error) throw error;
}

/** Sets a new password for the current session — used both from the settings page (already signed in) and from the post-recovery-link flow (a recovery session counts as signed in too). */
export async function updatePassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) throw error;
}

/**
 * Permanently deletes the current user's account: their auth.users row and,
 * via ON DELETE CASCADE, every owned DB row (profile, decks, cards, notes,
 * imports, jobs, review_log — see 20260724220036_remote_schema.sql). Storage
 * objects aren't part of that FK graph, so the edge function cleans those up
 * first, same reasoning as deleteDeckDeep in lib/decks.ts.
 *
 * Goes through an edge function (see supabase/functions/delete-account), not
 * a plain RPC, because deleting an auth.users row requires the service-role
 * key (supabase.auth.admin.deleteUser) — never something a client-side RPC
 * can hold.
 */
export async function deleteMyAccount(): Promise<void> {
  const { data, error } = await supabase.functions.invoke<{ ok: boolean; error?: string }>('delete-account');
  if (error) throw new Error(await functionErrorMessage(error));
  if (!data?.ok) throw new Error(data?.error ?? 'Could not delete your account.');
}

/**
 * supabase.functions.invoke's error on a non-2xx response is always the
 * generic "Edge Function returned a non-2xx status code" — the function's
 * own `{ ok: false, error: "..." }` JSON body, which has the actual reason,
 * is left on `error.context` (the raw Response) and never surfaced
 * automatically. Read it so a failure shows the real cause. Same pattern as
 * cloneErrorMessage in lib/decks.ts.
 */
async function functionErrorMessage(error: { message: string; context?: unknown }): Promise<string> {
  const context = error.context;
  if (context instanceof Response) {
    try {
      const body = (await context.clone().json()) as { error?: string };
      if (body?.error) return body.error;
    } catch {
      /* body wasn't JSON (e.g. a platform-level 546/504) — fall through to the generic message */
    }
  }
  return error.message;
}

/** Fires on sign-in, sign-out, and token refresh. Returns an unsubscribe function. */
export function onAuthChange(cb: (session: Session | null) => void): () => void {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return () => subscription.unsubscribe();
}
