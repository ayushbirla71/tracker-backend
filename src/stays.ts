import { haversine } from './geo.js';

export interface StayState {
  startAt: Date;
  endAt: Date;
  lat: number;
  lng: number;
  pointCount: number;
}

export interface StayPoint {
  recordedAt: Date;
  lat: number;
  lng: number;
  accuracy: number | null;
}

export interface StayOptions {
  radiusM: number;
  minSeconds: number;
  maxAccuracyM: number;
  /** A silence longer than this ends the stay: we can't claim the worker stood there while the phone sent nothing. */
  maxGapSeconds: number;
}

export interface StayStep {
  /** The stay that is open after this point (null when the point was ignored and nothing is open). */
  open: StayState | null;
  /** Set when this point ended the previous stay and it was long enough to keep. */
  finished: StayState | null;
}

export const durationSeconds = (s: StayState) => (s.endAt.getTime() - s.startAt.getTime()) / 1000;

/**
 * Advances stay detection by one GPS point. Points must be fed in chronological order.
 * A stay is a run of points that all lie within `radiusM` of the running centroid of the run.
 * Runs shorter than `minSeconds` are discarded when they end (the worker was just passing through).
 */
export function stepStay(open: StayState | null, p: StayPoint, opts: StayOptions): StayStep {
  if (p.accuracy != null && p.accuracy > opts.maxAccuracyM) return { open, finished: null };
  if (open && p.recordedAt <= open.endAt) return { open, finished: null }; // late / duplicate point

  const silent = open != null && (p.recordedAt.getTime() - open.endAt.getTime()) / 1000 > opts.maxGapSeconds;
  if (open && !silent && haversine(open.lat, open.lng, p.lat, p.lng) <= opts.radiusM) {
    const n = open.pointCount + 1;
    return {
      open: {
        startAt: open.startAt,
        endAt: p.recordedAt,
        lat: open.lat + (p.lat - open.lat) / n,
        lng: open.lng + (p.lng - open.lng) / n,
        pointCount: n,
      },
      finished: null,
    };
  }

  const finished = open && durationSeconds(open) >= opts.minSeconds ? open : null;
  return {
    open: { startAt: p.recordedAt, endAt: p.recordedAt, lat: p.lat, lng: p.lng, pointCount: 1 },
    finished,
  };
}
