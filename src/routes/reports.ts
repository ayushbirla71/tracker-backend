import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db.js';
import { parseRange } from '../range.js';
import { formatInZone, zoneLabel } from '../time.js';
import { requireAdmin } from './auth.js';

export interface WorkerSummary {
  worker_id: number;
  name: string;
  points: number;
  distance_m: number;
  stays: number;
  stay_seconds: number;
  first_seen: Date | null;
  last_seen: Date | null;
}

/** Per-worker totals for a window. Segments above 10 min apart are not counted as travel (device was off / no signal). */
export async function summarize(from: Date, to: Date, workerId: number | null = null): Promise<WorkerSummary[]> {
  const { rows } = await pool.query<WorkerSummary>(
    `WITH seg AS (
       SELECT worker_id, recorded_at,
              ST_Distance(geom, LAG(geom) OVER w) AS d,
              recorded_at - LAG(recorded_at) OVER w AS dt
       FROM locations
       WHERE recorded_at >= $1 AND recorded_at <= $2 AND ($3::int IS NULL OR worker_id = $3)
       WINDOW w AS (PARTITION BY worker_id ORDER BY recorded_at)
     ), dist AS (
       SELECT worker_id, count(*)::int AS points,
              COALESCE(SUM(d) FILTER (WHERE d > 15 AND dt < interval '10 minutes'), 0)::float8 AS distance_m,
              min(recorded_at) AS first_seen, max(recorded_at) AS last_seen
       FROM seg GROUP BY worker_id
     ), st AS (
       SELECT worker_id, count(*)::int AS stays,
              COALESCE(SUM(EXTRACT(EPOCH FROM LEAST(end_at, $2::timestamptz) - GREATEST(start_at, $1::timestamptz))), 0)::float8 AS stay_seconds
       FROM stays
       WHERE end_at >= $1 AND start_at <= $2 AND ($3::int IS NULL OR worker_id = $3)
         AND EXTRACT(EPOCH FROM end_at - start_at) >= $4
       GROUP BY worker_id
     )
     SELECT w.id AS worker_id, w.name,
            COALESCE(dist.points, 0) AS points, COALESCE(dist.distance_m, 0)::float8 AS distance_m,
            COALESCE(st.stays, 0) AS stays, COALESCE(st.stay_seconds, 0)::float8 AS stay_seconds,
            dist.first_seen, dist.last_seen
     FROM workers w
     LEFT JOIN dist ON dist.worker_id = w.id
     LEFT JOIN st ON st.worker_id = w.id
     WHERE w.active AND ($3::int IS NULL OR w.id = $3)
     ORDER BY w.name`,
    [from, to, workerId, config.STAY_MIN_SECONDS],
  );
  return rows;
}

// Times in exports are written in REPORT_TIMEZONE (IST by default) and the column headers say so; the database stays in UTC.
const TZ = zoneLabel(config.REPORT_TIMEZONE);

const csvCell = (v: unknown) => {
  if (v == null) return '';
  const s = v instanceof Date ? formatInZone(v, config.REPORT_TIMEZONE) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

export async function reportRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  app.get('/reports/summary', async (req, reply) => {
    const range = parseRange(req.query);
    if ('error' in range) return reply.code(400).send(range);
    return { from: range.from, to: range.to, workers: await summarize(range.from, range.to) };
  });

  app.get('/reports/summary.csv', async (req, reply) => {
    const range = parseRange(req.query);
    if ('error' in range) return reply.code(400).send(range);
    const rows = await summarize(range.from, range.to);
    const csv = toCsv(
      ['worker', 'distance_km', 'stays', 'stay_minutes', 'points', `first_seen (${TZ})`, `last_seen (${TZ})`],
      rows.map((r) => [r.name, (r.distance_m / 1000).toFixed(2), r.stays, Math.round(r.stay_seconds / 60), r.points, r.first_seen, r.last_seen]),
    );
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="summary.csv"').send(csv);
  });

  app.get('/reports/stays.csv', async (req, reply) => {
    const range = parseRange(req.query);
    if ('error' in range) return reply.code(400).send(range);
    const workerId = (req.query as { worker_id?: string }).worker_id;
    const { rows } = await pool.query(
      `SELECT w.name, s.start_at, s.end_at, EXTRACT(EPOCH FROM s.end_at - s.start_at)::float8 AS duration_s, s.lat, s.lng, s.address
       FROM stays s JOIN workers w ON w.id = s.worker_id
       WHERE s.end_at >= $1 AND s.start_at <= $2 AND ($3::int IS NULL OR s.worker_id = $3)
         AND EXTRACT(EPOCH FROM s.end_at - s.start_at) >= $4
       ORDER BY w.name, s.start_at`,
      [range.from, range.to, workerId ? Number(workerId) : null, config.STAY_MIN_SECONDS],
    );
    const csv = toCsv(
      ['worker', `arrived (${TZ})`, `left (${TZ})`, 'duration_minutes', 'lat', 'lng', 'address'],
      rows.map((r) => [r.name, r.start_at, r.end_at, Math.round(r.duration_s / 60), r.lat, r.lng, r.address]),
    );
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="stays.csv"').send(csv);
  });
}
