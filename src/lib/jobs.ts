import { supabase } from './supabase';
import type { Job, JobInsert, JobType } from '../types';

export async function createJob(job: JobInsert): Promise<Job> {
  const { data, error } = await supabase.from('jobs').insert(job).select().single();
  if (error) throw error;
  return data;
}

/** Lists the current user's jobs, optionally filtered by type, newest first. */
export async function listJobs(type?: JobType): Promise<Job[]> {
  let query = supabase.from('jobs').select('*').order('created_at', { ascending: false });
  if (type) query = query.eq('type', type);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

/**
 * Atomically claims up to `limit` queued jobs of `type`, flipping them to
 * 'processing'. Uses `FOR UPDATE SKIP LOCKED` server-side (see
 * claim_jobs in the Phase B jobs migration), so concurrent callers never
 * claim the same row.
 */
export async function claimJobs(type: JobType, limit = 5): Promise<Job[]> {
  const { data, error } = await supabase.rpc('claim_jobs', { p_type: type, p_limit: limit });
  if (error) throw error;
  return data;
}

export async function completeJob(jobId: string, result: Record<string, unknown> = {}): Promise<Job> {
  const { data, error } = await supabase.rpc('complete_job', { p_job_id: jobId, p_result: result });
  if (error) throw error;
  return data;
}

export async function failJob(jobId: string, errorMessage: string): Promise<Job> {
  const { data, error } = await supabase.rpc('fail_job', { p_job_id: jobId, p_error: errorMessage });
  if (error) throw error;
  return data;
}
