import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { pool, tx } from '../db.js';
import { parseRange } from '../range.js';
import { summarize } from './reports.js';
import { requireAdmin } from './auth.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const workerBody = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().max(50).nullish(),
  active: z.boolean().optional(),
});

const devicePatch = z.object({
  status: z.enum(['pending', 'active', 'blocked']).optional(),
  worker_id: z.number().int().positive().nullable().optional(),
  worker_name: z.string().min(1).max(200).optional(),
});

const geofenceBody = z.object({
  name: z.string().min(1).max(200),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radius_m: z.number().positive().max(100000),
});

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', async (req, reply) => {
    // device-facing routes live in routes/device.ts; everything registered in this plugin is admin-only
    return requireAdmin(req, reply);
  });

  // ---- workers -------------------------------------------------------------------------------
  app.get('/workers', async () => {
    const { rows } = await pool.query(
      `SELECT w.id, w.name, w.phone, w.active, w.created_at,
              (SELECT count(*)::int FROM devices d WHERE d.worker_id = w.id) AS device_count,
              l.recorded_at AS last_seen, l.battery,
              (l.recorded_at IS NOT NULL AND l.recorded_at > now() - make_interval(secs => $1)) AS online
       FROM workers w LEFT JOIN worker_last_location l ON l.worker_id = w.id
       ORDER BY w.active DESC, w.name`,
      [config.ONLINE_WINDOW_SECONDS],
    );
    return rows;
  });

  app.post('/workers', async (req, reply) => {
    const body = workerBody.parse(req.body);
    const { rows } = await pool.query('INSERT INTO workers (name, phone) VALUES ($1, $2) RETURNING *', [body.name, body.phone ?? null]);
    return reply.code(201).send(rows[0]);
  });

  app.patch('/workers/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = workerBody.partial().parse(req.body);
    const { rows } = await pool.query(
      `UPDATE workers SET name = COALESCE($2, name), phone = COALESCE($3, phone), active = COALESCE($4, active)
       WHERE id = $1 RETURNING *`,
      [id, body.name ?? null, body.phone ?? null, body.active ?? null],
    );
    if (!rows[0]) return reply.code(404).send({ error: 'worker not found' });
    return rows[0];
  });

  /** Live map: last known position of every active worker, plus how long they have been standing still. */
  app.get('/workers/live', async () => {
    const { rows } = await pool.query(
      `SELECT w.id AS worker_id, w.name, w.phone,
              l.recorded_at, l.lat, l.lng, l.accuracy, l.speed, l.heading, l.battery,
              (l.recorded_at IS NOT NULL AND l.recorded_at > now() - make_interval(secs => $1)) AS online,
              CASE WHEN s.id IS NOT NULL AND EXTRACT(EPOCH FROM s.end_at - s.start_at) >= $2 THEN s.start_at END AS stationary_since
       FROM workers w
       LEFT JOIN worker_last_location l ON l.worker_id = w.id
       LEFT JOIN stays s ON s.worker_id = w.id AND s.is_open
       WHERE w.active
       ORDER BY w.name`,
      [config.ONLINE_WINDOW_SECONDS, config.STAY_MIN_SECONDS],
    );
    return rows;
  });

  /** Route points for the map. Long ranges are thinned so the browser isn't sent hundreds of thousands of points. */
  app.get('/workers/:id/track', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const range = parseRange(req.query);
    if ('error' in range) return reply.code(400).send(range);
    const maxPoints = z.coerce.number().int().min(100).max(20000).catch(5000).parse((req.query as { max_points?: string }).max_points);

    const { rows } = await pool.query(
      `WITH p AS (
         SELECT recorded_at, lat, lng, accuracy, speed, battery,
                row_number() OVER (ORDER BY recorded_at) AS rn,
                count(*) OVER () AS cnt
         FROM locations WHERE worker_id = $1 AND recorded_at >= $2 AND recorded_at <= $3
       )
       SELECT recorded_at, lat, lng, accuracy, speed, battery FROM p
       WHERE cnt <= $4 OR rn % ceil(cnt::float8 / $4)::int = 1 OR rn = cnt
       ORDER BY recorded_at`,
      [id, range.from, range.to, maxPoints],
    );
    const [stats] = await summarize(range.from, range.to, id);
    return { from: range.from, to: range.to, stats: stats ?? null, points: rows };
  });

  app.get('/workers/:id/stays', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const range = parseRange(req.query);
    if ('error' in range) return reply.code(400).send(range);
    const { rows } = await pool.query(
      `SELECT id, start_at, end_at, lat, lng, point_count, address,
              EXTRACT(EPOCH FROM end_at - start_at)::float8 AS duration_s,
              (is_open AND end_at > now() - make_interval(secs => $5)) AS ongoing
       FROM stays
       WHERE worker_id = $1 AND end_at >= $2 AND start_at <= $3
         AND EXTRACT(EPOCH FROM end_at - start_at) >= $4
       ORDER BY start_at`,
      [id, range.from, range.to, config.STAY_MIN_SECONDS, config.ONLINE_WINDOW_SECONDS],
    );
    return rows;
  });

  // ---- devices -------------------------------------------------------------------------------
  app.get('/devices', async () => {
    const { rows } = await pool.query(
      `SELECT d.id, d.android_id, d.status, d.model, d.os, d.app_version, d.first_seen, d.last_seen,
              d.battery, d.gps_enabled, d.permission_ok, d.last_heartbeat,
              d.worker_id, w.name AS worker_name
       FROM devices d LEFT JOIN workers w ON w.id = d.worker_id
       ORDER BY (d.status = 'pending') DESC, d.last_seen DESC`,
    );
    return rows;
  });

  /** Approve / block a device and link it to a worker (existing, or created on the fly from worker_name). */
  app.patch('/devices/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = devicePatch.parse(req.body);

    const result = await tx(async (client) => {
      const current = await client.query<{ status: string; worker_id: number | null }>('SELECT status, worker_id FROM devices WHERE id = $1 FOR UPDATE', [id]);
      if (!current.rows[0]) return { code: 404, body: { error: 'device not found' } };

      let workerId = body.worker_id === undefined ? current.rows[0].worker_id : body.worker_id;
      if (body.worker_name) {
        const w = await client.query<{ id: number }>('INSERT INTO workers (name) VALUES ($1) RETURNING id', [body.worker_name]);
        workerId = w.rows[0]!.id;
      }
      const status = body.status ?? current.rows[0].status;
      if (status === 'active' && workerId == null) return { code: 400, body: { error: 'assign a worker before activating the device' } };

      const { rows } = await client.query('UPDATE devices SET status = $2, worker_id = $3 WHERE id = $1 RETURNING *', [id, status, workerId]);
      return { code: 200, body: rows[0] };
    });
    return reply.code(result.code).send(result.body);
  });

  // ---- geofences -----------------------------------------------------------------------------
  app.get('/geofences', async () => (await pool.query('SELECT * FROM geofences ORDER BY name')).rows);

  app.post('/geofences', async (req, reply) => {
    const b = geofenceBody.parse(req.body);
    const { rows } = await pool.query('INSERT INTO geofences (name, lat, lng, radius_m) VALUES ($1, $2, $3, $4) RETURNING *', [b.name, b.lat, b.lng, b.radius_m]);
    return reply.code(201).send(rows[0]);
  });

  app.delete('/geofences/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await pool.query('DELETE FROM geofences WHERE id = $1', [id]);
    return reply.code(204).send();
  });

  app.get('/geofence-events', async (req, reply) => {
    const range = parseRange(req.query);
    if ('error' in range) return reply.code(400).send(range);
    const workerId = (req.query as { worker_id?: string }).worker_id;
    const { rows } = await pool.query(
      `SELECT e.id, e.type, e.at, e.worker_id, w.name AS worker_name, e.geofence_id, g.name AS geofence_name
       FROM geofence_events e
       JOIN workers w ON w.id = e.worker_id
       JOIN geofences g ON g.id = e.geofence_id
       WHERE e.at >= $1 AND e.at <= $2 AND ($3::int IS NULL OR e.worker_id = $3)
       ORDER BY e.at DESC LIMIT 1000`,
      [range.from, range.to, workerId ? Number(workerId) : null],
    );
    return rows;
  });
}
