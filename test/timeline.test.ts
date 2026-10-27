import { describe, expect, it } from 'vitest';
import { buildTimeline, type Segment } from '../src/routes/insights.js';

const t = (min: number) => new Date(Date.UTC(2026, 0, 1, 0, min));
const min = (d: Date) => (d.getTime() - t(0).getTime()) / 60_000;
const seg = (type: Segment['type'], a: number, b: number): Segment => ({ type, start: t(a), end: t(b) });

describe('buildTimeline', () => {
  it('fills the space between stops with travel', () => {
    const out = buildTimeline(t(0), t(100), [seg('stopped', 20, 40), seg('stopped', 60, 80)]);
    expect(out.map((s) => [s.type, min(s.start), min(s.end)])).toEqual([
      ['moving', 0, 20],
      ['stopped', 20, 40],
      ['moving', 40, 60],
      ['stopped', 60, 80],
      ['moving', 80, 100],
    ]);
  });

  it('clips segments to the requested window and ignores ones outside it', () => {
    const out = buildTimeline(t(10), t(50), [seg('stopped', 0, 20), seg('no_signal', 45, 90), seg('stopped', 200, 220)]);
    expect(out.map((s) => s.type)).toEqual(['stopped', 'moving', 'no_signal']);
    expect(out[0]!.start).toEqual(t(10));
    expect(out[2]!.end).toEqual(t(50));
  });

  it('covers the whole window exactly once', () => {
    const out = buildTimeline(t(0), t(55), [seg('no_signal', 5, 15), seg('stopped', 30, 40)]);
    const total = out.reduce((s, x) => s + (x.end.getTime() - x.start.getTime()), 0);
    expect(total).toBe(55 * 60_000);
  });
});
