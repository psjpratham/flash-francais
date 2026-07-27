import type { Confidence, ExtractionDiagnostics } from '../types';

export interface NeedsReviewInput {
  confidence: Confidence;
  reviewReasons: string[];
  diagnostics?: ExtractionDiagnostics;
}

/**
 * Deterministic flagging only — no LLM call, no heuristic scoring. `true`
 * when any of: confidence is low, one or more review reasons exist, schema
 * validation required a retry, or unresolved source references exist.
 */
export function needsReview(input: NeedsReviewInput): boolean {
  if (input.confidence === 'low') return true;
  if (input.reviewReasons.length > 0) return true;
  if ((input.diagnostics?.schemaRetryCount ?? 0) > 0) return true;
  if ((input.diagnostics?.unresolvedReferences?.length ?? 0) > 0) return true;
  return false;
}
