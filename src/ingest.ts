import type { PoolClient } from 'pg';
import { z } from 'zod';
import { config } from './config.js';
import { checkBattery, raiseAlert, resolveAlert } from './alerts.js';
import { tx } from './db.js';
import { haversine } from './geo.js';
import { broadcast } from './live.js';
import { stepStay, type StayState } from './stays.js';

const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const MAX_FUTURE_MS = 10 * 60 * 1000;

const timestamp = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'invalid timestamp' });
    return z.NEVER;
  }
  return d;
});

const optionalNumber = z.number().finite().nullish();

export const pointSchema = z.object({
  t: timestamp,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: optionalNumber,
  speed: optionalNumber,
  heading: optionalNumber,
  battery: z.number().int().min(0).max(100).nullish(),
  mock: z.boolean().nullish(),
});

export interface Point {
  recordedAt: Date;
  lat: number;
  lng: number;
  accuracy: number | null;
  speed: number | null;
  heading: number | null;
  battery: number | null;
  mock: boolean;
}

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: number;
}

/** Validates raw points from the app; invalid ones are counted, not fatal, so one bad fix can't block a whole batch. */
export function parsePoints(raw: unknown[]): { points: Point[]; rejected: number } {
  const now = Date.now();
  const points: Point[] = [];
  let rejected = 0;
  for (const item of raw) {
    const r = pointSchema.safeParse(item);
    if (!r.success) {
      rejected++;
      continue;
    }
    const ms = r.data.t.getTime();
    if (ms < now - MAX_AGE_MS || ms > now + MAX_FUTURE_MS) {
      rejected++;
      continue;
    }
    points.push({
      recordedAt: r.data.t,
      lat: r.data.lat,
      lng: r.data.lng,
      accuracy: r.data.accuracy ?? null,
      speed: r.data.speed ?? null,
      heading: r.data.heading ?? null,
      battery: r.data.battery ?? null,
      mock: r.data.mock ?? false,
    });
  }
  points.sort((a, b) => a.recordedAt.getTime() - b.recordedAt.getTime());
  return { points, rejected };
}

export async function ingestPoints(workerId: number, deviceId: number, points: Point[], rejected: number): Promise<IngestResult> {
  if (points.length === 0) return { accepted: 0, duplicates: 0, rejected };

  const result = await tx(async (client) => {
    const { rows } = await client.query<{ recorded_at: Date; lat: number; lng: number; accuracy: number | null; speed: number | null; heading: number | null; battery: number | null }>(
      `INSERT INTO locations (worker_id, device_id, recorded_at, lat, lng, geom, accuracy, speed, heading, battery, is_mock)
       SELECT $1, $2, u.t, u.la, u.lo, ST_SetSRID(ST_MakePoint(u.lo, u.la), 4326)::geography, u.ac, u.sp, u.he, u.ba, u.mo
       FROM unnest($3::timestamptz[], $4::float8[], $5::float8[], $6::float8[], $7::float8[], $8::float8[], $9::int[], $10::bool[])
            AS u(t, la, lo, ac, sp, he, ba, mo)
       ON CONFLICT (device_id, recorded_at) DO NOTHING
       RETURNING recorded_at, lat, lng, accuracy, speed, heading, battery`,
      [
        workerId,
        deviceId,
        points.map((p) => p.recordedAt),
        points.map((p) => p.lat),
        points.map((p) => p.lng),
        points.map((p) => p.accuracy),
        points.map((p) => p.speed),
        points.map((p) => p.heading),
        points.map((p) => p.battery),
        points.map((p) => p.mock),
      ],
    );
    if (rows.length === 0) return { rows, transitions: [] as GeofenceTransition[] };

    rows.sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime());
    await updateLastLocation(client, workerId, deviceId, rows[rows.length - 1]!);
    await updateStays(client, workerId, points.filter((p) => rows.some((r) => r.recorded_at.getTime() === p.recordedAt.getTime())));
    const transitions = await updateGeofences(client, workerId, rows.map((r) => ({ at: r.recorded_at, lat: r.lat, lng: r.lng })));
    return { rows, transitions };
  });

  const fresh = result.rows;
  if (fresh.length > 0) {
    const last = fresh[fresh.length - 1]!;
    const mocked = points.some((p) => p.mock && fresh.some((r) => r.recorded_at.getTime() === p.recordedAt.getTime()));
    raiseAlertsFor(workerId, last, mocked, result.transitions).catch((err) => console.error('alert processing failed', err));
    broadcast({
      type: 'location',
      workerId,
      recordedAt: last.recorded_at,
      lat: last.lat,
      lng: last.lng,
      accuracy: last.accuracy,
      speed: last.speed,
      heading: last.heading,
      battery: last.battery,
    });
  }
  return { accepted: fresh.length, duplicates: points.length - fresh.length, rejected };
}

async function updateLastLocation(
  client: PoolClient,
  workerId: number,
  deviceId: number,
  last: { recorded_at: Date; lat: number; lng: number; accuracy: number | null; speed: number | null; heading: number | null; battery: number | null },
) {
  await client.query(
    `INSERT INTO worker_last_location (worker_id, device_id, recorded_at, lat, lng, accuracy, speed, heading, battery)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (worker_id) DO UPDATE SET device_id = EXCLUDED.device_id, recorded_at = EXCLUDED.recorded_at,
       lat = EXCLUDED.lat, lng = EXCLUDED.lng, accuracy = EXCLUDED.accuracy, speed = EXCLUDED.speed,
       heading = EXCLUDED.heading, battery = EXCLUDED.battery
     WHERE worker_last_location.recorded_at <= EXCLUDED.recorded_at`,
    [workerId, deviceId, last.recorded_at, last.lat, last.lng, last.accuracy, last.speed, last.heading, last.battery],
  );
}

async function updateStays(client: PoolClient, workerId: number, points: Point[]) {
  const existing = await client.query<{ id: string; start_at: Date; end_at: Date; lat: number; lng: number; point_count: number }>(
    'SELECT id, start_at, end_at, lat, lng, point_count FROM stays WHERE worker_id = $1 AND is_open FOR UPDATE',
    [workerId],
  );
  const row = existing.rows[0];
  let open: StayState | null = row
    ? { startAt: row.start_at, endAt: row.end_at, lat: row.lat, lng: row.lng, pointCount: row.point_count }
    : null;
  const finished: StayState[] = [];

  const opts = { radiusM: config.STAY_RADIUS_M, minSeconds: config.STAY_MIN_SECONDS, maxAccuracyM: config.MAX_ACCURACY_M, maxGapSeconds: config.STAY_MAX_GAP_SECONDS };
  for (const p of points) {
    const step = stepStay(open, { recordedAt: p.recordedAt, lat: p.lat, lng: p.lng, accuracy: p.accuracy }, opts);
    open = step.open;
    if (step.finished) finished.push(step.finished);
  }

  if (row) await client.query('DELETE FROM stays WHERE id = $1', [row.id]);
  for (const s of finished) {
    await client.query(
      'INSERT INTO stays (worker_id, start_at, end_at, lat, lng, point_count, is_open) VALUES ($1, $2, $3, $4, $5, $6, FALSE)',
      [workerId, s.startAt, s.endAt, s.lat, s.lng, s.pointCount],
    );
  }
  if (open) {
    await client.query(
      'INSERT INTO stays (worker_id, start_at, end_at, lat, lng, point_count, is_open) VALUES ($1, $2, $3, $4, $5, $6, TRUE)',
      [workerId, open.startAt, open.endAt, open.lat, open.lng, open.pointCount],
    );
  }
}

async function updateGeofences(client: PoolClient, workerId: number, points: { at: Date; lat: number; lng: number }[]) {
  const events: GeofenceTransition[] = [];
  const fences = (await client.query<{ id: number; name: string; lat: number; lng: number; radius_m: number }>('SELECT id, name, lat, lng, radius_m FROM geofences')).rows;
  if (fences.length === 0) return events;
  const state = new Map(
    (await client.query<{ geofence_id: number; inside: boolean }>('SELECT geofence_id, inside FROM geofence_state WHERE worker_id = $1', [workerId])).rows.map(
      (r) => [r.geofence_id, r.inside] as const,
    ),
  );

  for (const p of points) {
    for (const f of fences) {
      const inside = haversine(f.lat, f.lng, p.lat, p.lng) <= f.radius_m;
      const was = state.get(f.id);
      if (was === inside || (was === undefined && !inside)) {
        state.set(f.id, inside);
        continue;
      }
      state.set(f.id, inside);
      await client.query('INSERT INTO geofence_events (worker_id, geofence_id, type, at) VALUES ($1, $2, $3, $4)', [workerId, f.id, inside ? 'enter' : 'exit', p.at]);
      events.push({ name: f.name, type: inside ? 'enter' : 'exit', at: p.at });
    }
  }
  for (const [geofenceId, inside] of state) {
    await client.query(
      `INSERT INTO geofence_state (worker_id, geofence_id, inside) VALUES ($1, $2, $3)
       ON CONFLICT (worker_id, geofence_id) DO UPDATE SET inside = EXCLUDED.inside`,
      [workerId, geofenceId, inside],
    );
  }
  return events;
}

interface GeofenceTransition {
  name: string;
  type: 'enter' | 'exit';
  at: Date;
}

const LIVE_EVENT_WINDOW_MS = 15 * 60 * 1000;

/** Alerts that follow from fresh data. Runs after the transaction; a failure here must never lose the points. */
async function raiseAlertsFor(workerId: number, last: { battery: number | null }, mocked: boolean, transitions: GeofenceTransition[]) {
  await resolveAlert(workerId, 'offline');
  await checkBattery(workerId, last.battery);
  if (mocked) await raiseAlert(workerId, 'mock_location', 'warning', '%worker% is sending a mock (fake) GPS location', { condition: true });
  for (const t of transitions) {
    // history re-uploaded after being offline must not replay old arrivals as new alerts
    if (Date.now() - t.at.getTime() > LIVE_EVENT_WINDOW_MS) continue;
    await raiseAlert(workerId, t.type === 'enter' ? 'geofence_enter' : 'geofence_exit', 'info', `%worker% ${t.type === 'enter' ? 'arrived at' : 'left'} ${t.name}`);
  }
}
