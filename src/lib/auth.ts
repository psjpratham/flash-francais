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
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) throw error;
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

/** Fires on sign-in, sign-out, and token refresh. Returns an unsubscribe function. */
export function onAuthChange(cb: (session: Session | null) => void): () => void {
  const {
    data: { subscription },
  } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return () => subscription.unsubscribe();
}
