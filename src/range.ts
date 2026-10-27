import { z } from 'zod';

const PRESETS: Record<string, number> = {
  '1h': 1,
  '6h': 6,
  '12h': 12,
  '24h': 24,
  '48h': 48,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

const rangeQuery = z.object({
  range: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

/** Resolves `?range=24h|48h|7d|...` or an explicit `?from=&to=` (ISO dates) into a time window. */
export function parseRange(query: unknown): { from: Date; to: Date } | { error: string } {
  const q = rangeQuery.parse(query ?? {});
  const to = q.to ? new Date(q.to) : new Date();
  if (Number.isNaN(to.getTime())) return { error: 'invalid "to" date' };

  if (q.from) {
    const from = new Date(q.from);
    if (Number.isNaN(from.getTime())) return { error: 'invalid "from" date' };
    if (from >= to) return { error: '"from" must be before "to"' };
    return { from, to };
  }
  const hours = PRESETS[q.range ?? '24h'];
  if (!hours) return { error: `range must be one of ${Object.keys(PRESETS).join(', ')}` };
  return { from: new Date(to.getTime() - hours * 3600 * 1000), to };
}
