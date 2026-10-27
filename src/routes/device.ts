import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { checkBattery, raiseAlert, resolveAlert } from '../alerts.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { ingestPoints, parsePoints } from '../ingest.js';

const registerBody = z.object({
  device_id: z.string().min(4).max(128),
  model: z.string().max(200).optional(),
  os: z.string().max(100).optional(),
  app_version: z.string().max(50).optional(),
});

const batchBody = z.object({
  device_id: z.string().min(4).max(128),
  points: z.array(z.unknown()).max(500),
});

const heartbeatBody = z.object({
  device_id: z.string().min(4).max(128),
  battery: z.number().int().min(0).max(100).nullish(),
  gps_enabled: z.boolean().nullish(),
  permission_ok: z.boolean().nullish(),
  app_version: z.string().max(50).nullish(),
  // 'restarted': tracking came back after a reboot, app update, or the system killing it
  event: z.enum(['restarted']).nullish(),
});

/** Worker phones have no login: they prove they are our app with a shared key, and are identified by Android ID. */
async function requireAppKey(req: FastifyRequest, reply: import('fastify').FastifyReply) {
  if (req.headers['x-app-key'] !== config.APP_KEY) return reply.code(401).send({ error: 'invalid app key' });
}

const perDeviceLimit = {
  max: 120,
  timeWindow: '1 minute',
  hook: 'preHandler' as const,
  keyGenerator: (req: FastifyRequest) => String((req.body as { device_id?: string } | undefined)?.device_id ?? req.ip),
};

export async function deviceRoutes(app: FastifyInstance) {
  app.post('/devices/register', { onRequest: requireAppKey, config: { rateLimit: perDeviceLimit } }, async (req) => {
    const body = registerBody.parse(req.body);
    const initialStatus = config.REQUIRE_DEVICE_APPROVAL ? 'pending' : 'active';

    const { rows } = await pool.query<{ id: number; status: string; worker_id: number | null }>(
      `INSERT INTO devices (android_id, status, model, os, app_version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (android_id) DO UPDATE SET
         model = COALESCE(EXCLUDED.model, devices.model),
         os = COALESCE(EXCLUDED.os, devices.os),
         app_version = COALESCE(EXCLUDED.app_version, devices.app_version),
         last_seen = now()
       RETURNING id, status, worker_id`,
      [body.device_id, initialStatus, body.model ?? null, body.os ?? null, body.app_version ?? null],
    );
    let device = rows[0]!;

    // auto-accept mode: give an active device without a worker a placeholder worker the admin can rename
    if (device.status === 'active' && device.worker_id == null) {
      const name = `${body.model ?? 'Worker'} (${body.device_id.slice(-4)})`;
      const w = await pool.query<{ id: number }>('INSERT INTO workers (name) VALUES ($1) RETURNING id', [name]);
      await pool.query('UPDATE devices SET worker_id = $1 WHERE id = $2', [w.rows[0]!.id, device.id]);
      device = { ...device, worker_id: w.rows[0]!.id };
    }
    return { status: device.status, assigned: device.worker_id != null };
  });

  /** Phone health, sent about once a minute: lets the admin see "GPS turned off" even though no locations arrive. */
  app.post('/devices/heartbeat', { onRequest: requireAppKey, config: { rateLimit: perDeviceLimit } }, async (req, reply) => {
    const b = heartbeatBody.parse(req.body);
    const { rows } = await pool.query<{ id: number; status: string; worker_id: number | null }>(
      `UPDATE devices SET last_seen = now(), last_heartbeat = now(),
         battery = COALESCE($2, battery), gps_enabled = COALESCE($3, gps_enabled), permission_ok = COALESCE($4, permission_ok),
         app_version = COALESCE($5, app_version)
       WHERE android_id = $1 RETURNING id, status, worker_id`,
      [b.device_id, b.battery ?? null, b.gps_enabled ?? null, b.permission_ok ?? null, b.app_version ?? null],
    );
    const device = rows[0];
    if (!device) return reply.code(404).send({ status: 'unregistered' });

    if (device.status === 'active' && device.worker_id != null) {
      const w = device.worker_id;
      if (b.gps_enabled === false) await raiseAlert(w, 'gps_off', 'critical', '%worker% turned off GPS / location on the phone', { condition: true });
      else if (b.gps_enabled === true) await resolveAlert(w, 'gps_off');
      if (b.permission_ok === false) await raiseAlert(w, 'permission_revoked', 'critical', '%worker% removed the location permission from the app', { condition: true });
      else if (b.permission_ok === true) await resolveAlert(w, 'permission_revoked');
      await checkBattery(w, b.battery);
      if (b.event === 'restarted') await raiseAlert(w, 'tracking_restarted', 'info', `Tracking resumed on %worker%'s phone after a restart`);
    }
    return { status: device.status };
  });

  app.post('/locations/batch', { onRequest: requireAppKey, config: { rateLimit: perDeviceLimit } }, async (req, reply) => {
    const body = batchBody.parse(req.body);
    const { rows } = await pool.query<{ id: number; status: string; worker_id: number | null; worker_active: boolean | null }>(
      `SELECT d.id, d.status, d.worker_id, w.active AS worker_active
       FROM devices d LEFT JOIN workers w ON w.id = d.worker_id WHERE d.android_id = $1`,
      [body.device_id],
    );
    const device = rows[0];
    if (!device) return reply.code(404).send({ status: 'unregistered' });

    await pool.query('UPDATE devices SET last_seen = now() WHERE id = $1', [device.id]);
    if (device.status !== 'active' || device.worker_id == null || device.worker_active === false) {
      return reply.code(403).send({ status: device.status === 'active' ? 'blocked' : device.status });
    }

    const { points, rejected } = parsePoints(body.points);
    const result = await ingestPoints(device.worker_id, device.id, points, rejected);
    return { status: 'active', ...result };
  });
}
