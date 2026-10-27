import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool } from '../db.js';
import { parseRange } from '../range.js';
import { broadcast } from '../live.js';
import { requireAdmin } from './auth.js';
import { summarize } from './reports.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

// Gaps in GPS data longer than this are shown as "no signal" instead of travel.
const NO_SIGNAL_SECONDS = 600;

export type SegmentType = 'moving' | 'stopped' | 'no_signal';
export interface Segment {
  type: SegmentType;
  start: Date;
  end: Date;
}

/**
 * Lays stops and silences over [from, to]; whatever is left between them is travel.
 * Input segments must not overlap each other (stays are cut at gaps by stay detection).
 */
export function buildTimeline(from: Date, to: Date, marked: Segment[]): Segment[] {
  const out: Segment[] = [];
  let cursor = from.getTime();
  const sorted = [...marked].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const m of sorted) {
    const start = Math.max(m.start.getTime(), cursor);
    const end = Math.min(m.end.getTime(), to.getTime());
    if (end <= start) continue;
    if (start > cursor) out.push({ type: 'moving', start: new Date(cursor), end: new Date(start) });
    out.push({ type: m.type, start: new Date(start), end: new Date(end) });
    cursor = end;
  }
  if (cursor < to.getTime()) out.push({ type: 'moving', start: new Date(cursor), end: to });
  return out;
}

export async function insightRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin);

  app.get('/dashboard', async () => {
    const now = new Date();
    const from = new Date(now.getTime() - 24 * 3600 * 1000);

    const [counts, summary, hourly, alerts, unread] = await Promise.all([
      pool.query<{ total: number; online: number; reported: number; pending_devices: number }>(
        `SELECT (SELECT count(*)::int FROM workers WHERE active) AS total,
                (SELECT count(*)::int FROM workers w JOIN worker_last_location l ON l.worker_id = w.id
                   WHERE w.active AND l.recorded_at > now() - make_interval(secs => $1)) AS online,
                (SELECT count(*)::int FROM workers w JOIN worker_last_location l ON l.worker_id = w.id WHERE w.active) AS reported,
                (SELECT count(*)::int FROM devices WHERE status = 'pending') AS pending_devices`,
        [config.ONLINE_WINDOW_SECONDS],
      ),
      summarize(from, now),
      pool.query<{ hour: Date; workers: number }>(
        `SELECT date_trunc('hour', recorded_at) AS hour, count(DISTINCT worker_id)::int AS workers
         FROM locations WHERE recorded_at >= $1 GROUP BY 1 ORDER BY 1`,
        [from],
      ),
      pool.query(
        `SELECT a.id, a.type, a.severity, a.message, a.created_at, a.read_at, a.resolved_at, a.worker_id, w.name AS worker_name
         FROM alerts a JOIN workers w ON w.id = a.worker_id ORDER BY a.created_at DESC LIMIT 6`,
      ),
      pool.query<{ n: number }>('SELECT count(*)::int AS n FROM alerts WHERE read_at IS NULL'),
    ]);

    const c = counts.rows[0]!;
    const active = summary.filter((w) => w.points > 0);
    return {
      workers: { total: c.total, online: c.online, offline: c.reported - c.online, never_reported: c.total - c.reported },
      pending_devices: c.pending_devices,
      last24h: {
        distance_m: summary.reduce((s, w) => s + w.distance_m, 0),
        stops: summary.reduce((s, w) => s + w.stays, 0),
        stay_seconds: summary.reduce((s, w) => s + w.stay_seconds, 0),
        active_workers: active.length,
      },
      top_distance: [...active].sort((a, b) => b.distance_m - a.distance_m).slice(0, 5).map((w) => ({ worker_id: w.worker_id, name: w.name, distance_m: w.distance_m, stays: w.stays })),
      hourly: hourly.rows,
      recent_alerts: alerts.rows,
      unread_alerts: unread.rows[0]!.n,
    };
  });

  /** Moving / stopped / no-signal bar for a worker over the chosen range. */
  app.get('/workers/:id/timeline', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const range = parseRange(req.query);
    if ('error' in range) return reply.code(400).send(range);
    const { from, to } = range;

    const [stays, gaps, edges] = await Promise.all([
      pool.query<{ start_at: Date; end_at: Date }>(
        `SELECT start_at, end_at FROM stays
         WHERE worker_id = $1 AND end_at >= $2 AND start_at <= $3 AND EXTRACT(EPOCH FROM end_at - start_at) >= $4`,
        [id, from, to, config.STAY_MIN_SECONDS],
      ),
      pool.query<{ prev: Date; at: Date }>(
        `SELECT prev, at FROM (
           SELECT recorded_at AS at, LAG(recorded_at) OVER (ORDER BY recorded_at) AS prev
           FROM locations WHERE worker_id = $1 AND recorded_at >= $2 AND recorded_at <= $3
         ) s WHERE prev IS NOT NULL AND at - prev > make_interval(secs => $4)`,
        [id, from, to, NO_SIGNAL_SECONDS],
      ),
      pool.query<{ first: Date | null; last: Date | null }>(
        'SELECT min(recorded_at) AS first, max(recorded_at) AS last FROM locations WHERE worker_id = $1 AND recorded_at >= $2 AND recorded_at <= $3',
        [id, from, to],
      ),
    ]);

    const marked: Segment[] = [
      ...stays.rows.map((s) => ({ type: 'stopped' as const, start: s.start_at, end: s.end_at })),
      ...gaps.rows.map((g) => ({ type: 'no_signal' as const, start: g.prev, end: g.at })),
    ];
    const { first, last } = edges.rows[0]!;
    if (!first || !last) {
      marked.push({ type: 'no_signal', start: from, end: to });
    } else {
      if (first.getTime() - from.getTime() > NO_SIGNAL_SECONDS * 1000) marked.push({ type: 'no_signal', start: from, end: first });
      if (to.getTime() - last.getTime() > NO_SIGNAL_SECONDS * 1000) marked.push({ type: 'no_signal', start: last, end: to });
    }

    const segments = buildTimeline(from, to, marked);
    const totals: Record<SegmentType, number> = { moving: 0, stopped: 0, no_signal: 0 };
    for (const s of segments) totals[s.type] += (s.end.getTime() - s.start.getTime()) / 1000;
    return { from, to, segments, totals };
  });

  // ---- alerts --------------------------------------------------------------------------------
  const alertQuery = z.object({
    status: z.enum(['all', 'unread', 'open']).default('all'),
    type: z.string().max(40).optional(),
    worker_id: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  });

  app.get('/alerts', async (req) => {
    const q = alertQuery.parse(req.query);
    const { rows } = await pool.query(
      `SELECT a.id, a.type, a.severity, a.message, a.is_condition, a.created_at, a.read_at, a.resolved_at, a.worker_id, w.name AS worker_name
       FROM alerts a JOIN workers w ON w.id = a.worker_id
       WHERE ($1 = 'all' OR ($1 = 'unread' AND a.read_at IS NULL) OR ($1 = 'open' AND a.is_condition AND a.resolved_at IS NULL))
         AND ($2::text IS NULL OR a.type = $2) AND ($3::int IS NULL OR a.worker_id = $3)
       ORDER BY a.created_at DESC LIMIT $4`,
      [q.status, q.type ?? null, q.worker_id ?? null, q.limit],
    );
    return rows;
  });

  app.get('/alerts/unread-count', async () => {
    const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM alerts WHERE read_at IS NULL');
    return { unread: rows[0]!.n };
  });

  app.post('/alerts/read', async (req) => {
    const { ids } = z.object({ ids: z.array(z.number().int()).max(500).optional() }).parse(req.body ?? {});
    const { rowCount } = await pool.query(
      `UPDATE alerts SET read_at = now() WHERE read_at IS NULL AND ($1::bigint[] IS NULL OR id = ANY($1::bigint[]))`,
      [ids ?? null],
    );
    return { updated: rowCount ?? 0 };
  });

  // Clearing deletes alerts for every admin. Issues that are still ongoing (worker offline, GPS off...) can't be
  // cleared: they would be raised again at the next check, so they stay until the cause is gone.
  const NOT_ONGOING = 'NOT (is_condition AND resolved_at IS NULL)';

  app.delete('/alerts/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { rowCount } = await pool.query(`DELETE FROM alerts WHERE id = $1 AND ${NOT_ONGOING}`, [id]);
    if (!rowCount) {
      const exists = await pool.query('SELECT 1 FROM alerts WHERE id = $1', [id]);
      return exists.rowCount ? reply.code(409).send({ error: 'this issue is still ongoing and will clear itself once it is resolved' }) : reply.code(404).send({ error: 'alert not found' });
    }
    broadcast({ type: 'alerts-cleared' });
    return reply.code(204).send();
  });

  app.delete('/alerts', async (req) => {
    const { scope } = z.object({ scope: z.enum(['read', 'all']) }).parse(req.query);
    const { rowCount } = await pool.query(`DELETE FROM alerts WHERE ${NOT_ONGOING} AND ($1 = 'all' OR read_at IS NOT NULL)`, [scope]);
    const deleted = rowCount ?? 0;
    if (deleted > 0) broadcast({ type: 'alerts-cleared' });
    return { deleted };
  });
}
