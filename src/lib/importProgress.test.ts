import { describe, expect, it } from 'vitest';
import { isTerminal } from './importProgress';

describe('isTerminal', () => {
  it('is false for pending and running', () => {
    expect(isTerminal('pending')).toBe(false);
    expect(isTerminal('running')).toBe(false);
  });

  it('is true for completed, completed_with_errors, and failed', () => {
    expect(isTerminal('completed')).toBe(true);
    expect(isTerminal('completed_with_errors')).toBe(true);
    expect(isTerminal('failed')).toBe(true);
  });
});
