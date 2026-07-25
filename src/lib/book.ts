import { supabase } from './supabase';
import type { BookLesson } from '../types';

export async function listBookLessons(): Promise<BookLesson[]> {
  const { data, error } = await supabase.from('book_lessons').select('*').order('order_index', { ascending: true });
  if (error) throw error;
  return data;
}
