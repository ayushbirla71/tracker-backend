import { describe, expect, it } from 'vitest';
import { durationSeconds, stepStay, type StayState } from '../src/stays.js';

const opts = { radiusM: 50, minSeconds: 300, maxAccuracyM: 50, maxGapSeconds: 900 };
const T0 = Date.UTC(2026, 0, 1, 8, 0, 0);

/** ~1 m of latitude in degrees, to build tracks by metres */
const M = 1 / 111_320;

function run(track: { sec: number; northM: number; accuracy?: number }[]) {
  let open: StayState | null = null;
  const finished: StayState[] = [];
  for (const p of track) {
    const step = stepStay(open, { recordedAt: new Date(T0 + p.sec * 1000), lat: 20 + p.northM * M, lng: 73, accuracy: p.accuracy ?? 5 }, opts);
    open = step.open;
    if (step.finished) finished.push(step.finished);
  }
  return { open, finished };
}

describe('stay detection', () => {
  it('turns 10 minutes at one spot into a single stay', () => {
    const track = Array.from({ length: 21 }, (_, i) => ({ sec: i * 30, northM: (i % 3) * 4 })); // GPS jitter of a few metres
    const { open, finished } = run(track);
    expect(finished).toHaveLength(0);
    expect(open && durationSeconds(open)).toBe(600);
  });

  it('closes the stay when the worker walks away and keeps it', () => {
    const still = Array.from({ length: 21 }, (_, i) => ({ sec: i * 30, northM: 0 }));
    const walking = [{ sec: 640, northM: 200 }, { sec: 670, northM: 240 }];
    const { finished, open } = run([...still, ...walking]);
    expect(finished).toHaveLength(1);
    expect(durationSeconds(finished[0]!)).toBe(600);
    expect(open?.startAt.getTime()).toBe(T0 + 640_000);
  });

  it('ignores someone just passing through', () => {
    const walking = Array.from({ length: 10 }, (_, i) => ({ sec: i * 30, northM: i * 100 })); // ~3 m/s, never inside 50 m twice
    const { finished } = run([...walking, { sec: 400, northM: 5000 }]);
    expect(finished).toHaveLength(0);
  });

  it('drops a short pause below the minimum duration', () => {
    const { finished } = run([
      { sec: 0, northM: 0 },
      { sec: 60, northM: 2 },
      { sec: 120, northM: 1 }, // 2 minutes only
      { sec: 150, northM: 500 },
    ]);
    expect(finished).toHaveLength(0);
  });

  it('does not count a long silence at the same spot as standing time', () => {
    const before = Array.from({ length: 11 }, (_, i) => ({ sec: i * 60, northM: 0 })); // 10 min
    const after = Array.from({ length: 11 }, (_, i) => ({ sec: 7200 + i * 60, northM: 1 })); // back 2h later, same spot
    const { finished, open } = run([...before, ...after]);
    expect(finished).toHaveLength(1);
    expect(durationSeconds(finished[0]!)).toBe(600);
    expect(open && durationSeconds(open)).toBe(600);
  });

  it('skips inaccurate fixes and late points', () => {
    const { open } = run([
      { sec: 0, northM: 0 },
      { sec: 60, northM: 900, accuracy: 300 }, // bad fix far away must not end the stay
      { sec: 120, northM: 3 },
      { sec: 90, northM: 0 }, // out of order: older than the stay's latest point
    ]);
    expect(open && durationSeconds(open)).toBe(120);
    expect(open?.pointCount).toBe(2);
  });
});
