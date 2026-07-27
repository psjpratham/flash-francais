import { describe, expect, it } from 'vitest';
import { needsReview } from './reviewMetadata';

describe('needsReview', () => {
  it('is false for approved-looking content: high confidence, no reasons, no diagnostics', () => {
    expect(needsReview({ confidence: 'high', reviewReasons: [] })).toBe(false);
  });

  it('is false for medium confidence with no other flags', () => {
    expect(needsReview({ confidence: 'medium', reviewReasons: [] })).toBe(false);
  });

  it('is true when confidence is low', () => {
    expect(needsReview({ confidence: 'low', reviewReasons: [] })).toBe(true);
  });

  it('is true when one or more review reasons exist', () => {
    expect(needsReview({ confidence: 'high', reviewReasons: ['ambiguous gender'] })).toBe(true);
  });

  it('is true when schema validation required a retry', () => {
    expect(
      needsReview({ confidence: 'high', reviewReasons: [], diagnostics: { schemaRetryCount: 1 } }),
    ).toBe(true);
  });

  it('is false when schemaRetryCount is exactly 0', () => {
    expect(
      needsReview({ confidence: 'high', reviewReasons: [], diagnostics: { schemaRetryCount: 0 } }),
    ).toBe(false);
  });

  it('is true when unresolved source references exist', () => {
    expect(
      needsReview({
        confidence: 'high',
        reviewReasons: [],
        diagnostics: { unresolvedReferences: ['piste-042'] },
      }),
    ).toBe(true);
  });

  it('is false when unresolvedReferences is an empty array', () => {
    expect(
      needsReview({ confidence: 'high', reviewReasons: [], diagnostics: { unresolvedReferences: [] } }),
    ).toBe(false);
  });
});
