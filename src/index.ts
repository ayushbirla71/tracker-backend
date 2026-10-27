import bcrypt from 'bcryptjs';
import { runMonitor } from './alerts.js';
import { config } from './config.js';
import { geocodeNextStay } from './geocode.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { buildServer } from './server.js';

async function seedAdmin(log: (msg: string) => void) {
  const { rows } = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM admins');
  if (rows[0]!.n > 0) return;
  const hash = await bcrypt.hash(config.ADMIN_PASSWORD, 10);
  await pool.query('INSERT INTO admins (name, email, password_hash, is_system) VALUES ($1, $2, $3, TRUE)', ['System Administrator', config.ADMIN_EMAIL, hash]);
  log(`created the system admin ${config.ADMIN_EMAIL} - change the password from the .env defaults`);
}

async function purgeOldData() {
  if (config.RETENTION_DAYS <= 0) return;
  const days = config.RETENTION_DAYS;
  await pool.query(`DELETE FROM locations WHERE recorded_at < now() - make_interval(days => $1)`, [days]);
  await pool.query(`DELETE FROM stays WHERE NOT is_open AND end_at < now() - make_interval(days => $1)`, [days]);
  await pool.query(`DELETE FROM alerts WHERE created_at < now() - make_interval(days => $1)`, [days]);
  await pool.query(`DELETE FROM geofence_events WHERE at < now() - make_interval(days => $1)`, [days]);
}

const app = await buildServer();
await migrate((m) => app.log.info(m));
await seedAdmin((m) => app.log.info(m));

const retentionTimer = setInterval(() => purgeOldData().catch((e) => app.log.error(e)), 6 * 3600 * 1000);
purgeOldData().catch((e) => app.log.error(e));

const monitorTimer = setInterval(() => runMonitor().catch((e) => app.log.error(e)), 30_000);
runMonitor().catch((e) => app.log.error(e));

let geocodeTimer: NodeJS.Timeout | undefined;
if (config.REVERSE_GEOCODE) {
  app.log.info('reverse geocoding of stops is ON (OpenStreetMap Nominatim)');
  geocodeTimer = setInterval(() => geocodeNextStay().catch((e) => app.log.error(e)), 2_000);
}

const shutdown = async () => {
  clearInterval(retentionTimer);
  clearInterval(monitorTimer);
  clearInterval(geocodeTimer);
  await app.close();
  await pool.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.PORT, host: '0.0.0.0' });
