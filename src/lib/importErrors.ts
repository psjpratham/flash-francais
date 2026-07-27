import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js';

/**
 * User-facing error buckets for the import flow. Deliberately doesn't expose
 * RPC names, Edge Function terminology, or raw job statuses — those live in
 * `detail` for the expandable technical-details area only.
 */
export type ImportErrorCategory =
  | 'function_unavailable'
  | 'auth_failure'
  | 'missing_import_or_source'
  | 'storage_access_failure'
  | 'pdf_extraction_failure'
  | 'unexpected_server_error';

export interface ClassifiedImportError {
  category: ImportErrorCategory;
  message: string;
  detail: string;
}

const AUTH_CODES = new Set(['unauthenticated']);
const MISSING_CODES = new Set([
  'invalid_import_id',
  'invalid_body',
  'import_not_found',
  'page_missing',
  'page_has_no_text',
  'textbook_required',
  'textbook_must_be_pdf',
  'method_not_allowed',
]);
const STORAGE_CODES = new Set(['textbook_unreadable']);

/** Classifies any error thrown by the import flow (Edge Function calls, storage uploads, table reads) into a stable, user-facing category. */
export async function classifyImportError(e: unknown): Promise<ClassifiedImportError> {
  if (e instanceof FunctionsFetchError) {
    return {
      category: 'function_unavailable',
      message: 'Could not reach the import service. It may not be deployed, or your connection dropped — try again in a moment.',
      detail: `FunctionsFetchError: ${e.message}`,
    };
  }
  if (e instanceof FunctionsRelayError) {
    return {
      category: 'function_unavailable',
      message: 'The import service is temporarily unreachable. Please try again.',
      detail: `FunctionsRelayError: ${e.message}`,
    };
  }
  if (e instanceof FunctionsHttpError) {
    let body: { error?: string } = {};
    try {
      body = await e.context.json();
    } catch {
      /* non-JSON body — fall through with an empty code */
    }
    const status: number | undefined = e.context?.status;
    const code = body.error ?? 'unknown_error';

    if (status === 401 || status === 403 || AUTH_CODES.has(code)) {
      return { category: 'auth_failure', message: 'Your session has expired — sign in again and retry.', detail: `HTTP ${status}: ${code}` };
    }
    if (MISSING_CODES.has(code)) {
      return {
        category: 'missing_import_or_source',
        message: 'This import or its source file could not be found. Try re-uploading the file.',
        detail: `HTTP ${status}: ${code}`,
      };
    }
    if (STORAGE_CODES.has(code)) {
      return {
        category: 'storage_access_failure',
        message: 'The uploaded file could not be read back from storage. Try re-uploading it.',
        detail: `HTTP ${status}: ${code}`,
      };
    }
    if (status != null && status >= 500) {
      return { category: 'unexpected_server_error', message: 'Something went wrong on our side. Please try again.', detail: `HTTP ${status}: ${code}` };
    }
    return { category: 'unexpected_server_error', message: 'The import step failed unexpectedly.', detail: `HTTP ${status}: ${code}` };
  }
  return {
    category: 'unexpected_server_error',
    message: 'Something went wrong.',
    detail: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
  };
}
