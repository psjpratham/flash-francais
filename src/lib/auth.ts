import { supabase } from './supabase';
import type { Session } from '@supabase/supabase-js';
import type { UserRole } from '../types';

export async function getSession(): Promise<Session | null> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  return data.session;
}

/** The current user's role, via their own profile row (RLS only allows reading your own). */
export async function getMyRole(): Promise<UserRole> {
  const { data, error } = await supabase.from('profiles').select('role').single();
  if (error) throw error;
  return data.role;
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
