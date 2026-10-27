import { describe, expect, it } from 'vitest';
import { formatInZone, isValidTimeZone, zoneLabel } from '../src/time.js';

describe('formatInZone', () => {
  it('converts UTC to IST (+05:30)', () => {
    expect(formatInZone(new Date('2026-10-27T08:30:00Z'), 'Asia/Kolkata')).toBe('2026-10-27 14:00:00');
    expect(formatInZone(new Date('2026-10-27T00:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-27 05:30:00');
  });

  it('moves the date forward when IST is past midnight', () => {
    expect(formatInZone(new Date('2026-10-26T19:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-27 00:30:00');
    expect(formatInZone(new Date('2026-12-31T18:30:00Z'), 'Asia/Kolkata')).toBe('2027-01-01 00:00:00');
  });

  it('writes midnight as 00, never 24', () => {
    expect(formatInZone(new Date('2026-10-26T18:30:00Z'), 'Asia/Kolkata')).toBe('2026-10-27 00:00:00');
  });

  it('keeps seconds and ignores milliseconds', () => {
    expect(formatInZone(new Date('2026-10-27T08:30:09.987Z'), 'Asia/Kolkata')).toBe('2026-10-27 14:00:09');
  });

  it('works for other zones, including daylight saving', () => {
    expect(formatInZone(new Date('2026-10-27T08:30:00Z'), 'UTC')).toBe('2026-10-27 08:30:00');
    expect(formatInZone(new Date('2026-07-01T12:00:00Z'), 'America/New_York')).toBe('2026-07-01 08:00:00'); // EDT, UTC-4
    expect(formatInZone(new Date('2026-01-01T12:00:00Z'), 'America/New_York')).toBe('2026-01-01 07:00:00'); // EST, UTC-5
  });
});

describe('time zone helpers', () => {
  it('validates zone names', () => {
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('labels India as IST and other zones by name', () => {
    expect(zoneLabel('Asia/Kolkata')).toBe('IST');
    expect(zoneLabel('UTC')).toBe('UTC');
  });
});
