import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Deck } from '../types';

interface Call {
  method: string;
  args: unknown[];
}

/**
 * A chainable stand-in for a PostgrestFilterBuilder: every method call is
 * recorded and returns the same proxy so `.eq().neq().order().limit()` etc.
 * keeps working, and `await`-ing it resolves via `resolve(calls)`.
 */
function createQueryBuilder(resolve: (calls: Call[]) => { data: unknown[]; error: null }) {
  const calls: Call[] = [];
  const builder: Record<string, unknown> = {};
  const proxy = new Proxy(builder, {
    get(_target, prop: string) {
      if (prop === 'then') {
        return (onFulfilled: (v: { data: unknown[]; error: null }) => void) =>
          Promise.resolve(resolve(calls)).then(onFulfilled);
      }
      return (...args: unknown[]) => {
        calls.push({ method: prop, args });
        return proxy;
      };
    },
  });
  return { proxy, calls };
}

const DUE_FIXTURE = [{ id: 'due-1', state: 'review' }, { id: 'due-2', state: 'review' }];
const NEW_FIXTURE = [{ id: 'new-1', state: 'new' }, { id: 'new-2', state: 'new' }];

const builderLog: Call[][] = [];

vi.mock('./supabase', () => ({
  supabase: {
    from: vi.fn(() => {
      const { proxy, calls } = createQueryBuilder((calls) => {
        const isDueQuery = calls.some((c) => c.method === 'neq' && c.args[0] === 'state' && c.args[1] === 'new');
        const isNewQuery = calls.some((c) => c.method === 'eq' && c.args[0] === 'state' && c.args[1] === 'new');
        if (isDueQuery) return { data: DUE_FIXTURE, error: null };
        if (isNewQuery) return { data: NEW_FIXTURE, error: null };
        return { data: [], error: null };
      });
      builderLog.push(calls);
      return proxy;
    }),
  },
}));

const { loadQueueForDeck } = await import('./cards');

function testDeck(overrides: Partial<Deck> = {}): Deck {
  return {
    id: 'deck-1',
    user_id: 'user-1',
    name: 'Test deck',
    source: 'test',
    review_per_day: 20,
    new_per_day: 10,
    desired_retention: 0.9,
    visibility: 'personal',
    status: 'published',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  builderLog.length = 0;
});

describe('loadQueueForDeck', () => {
  it('combines due + new cards (shuffled) and applies each daily limit', async () => {
    const deck = testDeck({ review_per_day: 5, new_per_day: 3 });
    const queue = await loadQueueForDeck(deck);

    expect(queue.map((c) => c.id).sort()).toEqual(
      [...DUE_FIXTURE, ...NEW_FIXTURE].map((c) => c.id).sort(),
    );

    const dueCalls = builderLog.find((calls) => calls.some((c) => c.method === 'neq'))!;
    const newCalls = builderLog.find(
      (calls) => calls.some((c) => c.method === 'eq' && c.args[0] === 'state' && c.args[1] === 'new'),
    )!;
    expect(dueCalls.find((c) => c.method === 'limit')?.args).toEqual([5]);
    expect(newCalls.find((c) => c.method === 'limit')?.args).toEqual([3]);
    // no tag filter requested -> no !inner join, no overlaps call
    expect(dueCalls.some((c) => c.method === 'overlaps')).toBe(false);
    expect(dueCalls.find((c) => c.method === 'select')?.args[0]).not.toContain('!inner');
  });

  it('filters by tags via notes!inner + overlaps when tags are passed', async () => {
    const deck = testDeck();
    await loadQueueForDeck(deck, ['grammar', 'unit3']);

    for (const calls of builderLog) {
      expect(calls.find((c) => c.method === 'select')?.args[0]).toContain('notes!inner');
      expect(calls.find((c) => c.method === 'overlaps')?.args).toEqual(['notes.tags', ['grammar', 'unit3']]);
    }
  });
});
