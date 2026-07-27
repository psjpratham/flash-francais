import { describe, expect, it } from 'vitest';
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';
import { classifyImportError } from './importErrors';

function httpError(status: number, body: unknown): FunctionsHttpError {
  return new FunctionsHttpError({ status, json: async () => body });
}

describe('classifyImportError', () => {
  it('classifies a network-level failure ("Failed to send a request") as function_unavailable', async () => {
    const result = await classifyImportError(new FunctionsFetchError({}));
    expect(result.category).toBe('function_unavailable');
    expect(result.detail).toContain('FunctionsFetchError');
  });

  it('classifies a relay error as function_unavailable', async () => {
    const result = await classifyImportError(new FunctionsRelayError({}));
    expect(result.category).toBe('function_unavailable');
  });

  it('classifies HTTP 401 as auth_failure', async () => {
    const result = await classifyImportError(httpError(401, { error: 'unauthenticated' }));
    expect(result.category).toBe('auth_failure');
  });

  it('classifies a missing-import error code as missing_import_or_source', async () => {
    const result = await classifyImportError(httpError(400, { error: 'invalid_import_id' }));
    expect(result.category).toBe('missing_import_or_source');
  });

  it('classifies textbook_required as missing_import_or_source', async () => {
    const result = await classifyImportError(httpError(400, { error: 'textbook_required' }));
    expect(result.category).toBe('missing_import_or_source');
  });

  it('classifies textbook_unreadable as storage_access_failure', async () => {
    const result = await classifyImportError(httpError(502, { error: 'textbook_unreadable' }));
    expect(result.category).toBe('storage_access_failure');
  });

  it('classifies textbook_must_be_pdf as missing_import_or_source', async () => {
    const result = await classifyImportError(httpError(400, { error: 'textbook_must_be_pdf' }));
    expect(result.category).toBe('missing_import_or_source');
  });

  it('classifies page_has_no_text as missing_import_or_source', async () => {
    const result = await classifyImportError(httpError(400, { error: 'page_has_no_text' }));
    expect(result.category).toBe('missing_import_or_source');
  });

  it('classifies an unrecognized 5xx as unexpected_server_error', async () => {
    const result = await classifyImportError(httpError(500, { error: 'internal_error' }));
    expect(result.category).toBe('unexpected_server_error');
  });

  it('classifies a plain Error as unexpected_server_error and preserves its message in detail', async () => {
    const result = await classifyImportError(new Error('boom'));
    expect(result.category).toBe('unexpected_server_error');
    expect(result.detail).toContain('boom');
  });

  it('never leaks raw job-status/RPC vocabulary into the user-facing message', async () => {
    const result = await classifyImportError(httpError(500, { error: 'internal_error' }));
    expect(result.message.toLowerCase()).not.toContain('rpc');
    expect(result.message.toLowerCase()).not.toContain('job');
  });
});
