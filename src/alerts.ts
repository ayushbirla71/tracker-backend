import { config } from './config.js';
import { pool } from './db.js';
import { broadcast } from './live.js';

export type AlertType = 'offline' | 'low_battery' | 'gps_off' | 'permission_revoked' | 'mock_location' | 'tracking_restarted' | 'geofence_enter' | 'geofence_exit';
export type Severity = 'info' | 'warning' | 'critical';

interface RaiseOptions {
  /** Condition alerts stay open (one per worker + type) until resolveAlert is called. */
  condition?: boolean;
}

/** `%worker%` in the message is replaced with the worker's name. Returns null when an identical condition is already open. */
export async function raiseAlert(workerId: number, type: AlertType, severity: Severity, message: string, opts: RaiseOptions = {}) {
  const { rows } = await pool.query(
    `WITH ins AS (
       INSERT INTO alerts (worker_id, type, severity, message, is_condition)
       SELECT w.id, $2, $3, replace($4, '%worker%', w.name), $5 FROM workers w WHERE w.id = $1
       ON CONFLICT DO NOTHING
       RETURNING *
     )
     SELECT ins.*, w.name AS worker_name FROM ins JOIN workers w ON w.id = ins.worker_id`,
    [workerId, type, severity, message, opts.condition ?? false],
  );
  const alert = rows[0];
  if (alert) broadcast({ type: 'alert', alert });
  return alert ?? null;
}

export async function resolveAlert(workerId: number, type: AlertType) {
  const { rowCount } = await pool.query(
    `UPDATE alerts SET resolved_at = now() WHERE worker_id = $1 AND type = $2 AND is_condition AND resolved_at IS NULL`,
    [workerId, type],
  );
  if (rowCount) broadcast({ type: 'alert-resolved', workerId, alertType: type });
}

const BATTERY_RECOVERY_MARGIN = 5;

/** Battery from a location batch or heartbeat. Raises once when it drops low, clears when it has recovered. */
export async function checkBattery(workerId: number, battery: number | null | undefined) {
  if (battery == null) return;
  if (battery <= config.LOW_BATTERY_PERCENT) {
    await raiseAlert(workerId, 'low_battery', battery <= 5 ? 'critical' : 'warning', `%worker%'s phone battery is at ${battery}%`, { condition: true });
  } else if (battery > config.LOW_BATTERY_PERCENT + BATTERY_RECOVERY_MARGIN) {
    await resolveAlert(workerId, 'low_battery');
  }
}

/** Periodic checks that can't be triggered by an incoming request (silence is the signal). */
export async function runMonitor() {
  const minutes = config.OFFLINE_ALERT_MINUTES;

  // Went quiet. Only workers seen in the last 24h: older silence is not news and would flood the list on first start.
  const quiet = await pool.query<{ worker_id: number; recorded_at: Date; battery: number | null }>(
    `SELECT l.worker_id, l.recorded_at, l.battery
     FROM worker_last_location l
     JOIN workers w ON w.id = l.worker_id AND w.active
     JOIN devices d ON d.worker_id = w.id AND d.status = 'active'
     WHERE l.recorded_at < now() - make_interval(mins => $1) AND l.recorded_at > now() - interval '24 hours'
     GROUP BY l.worker_id, l.recorded_at, l.battery`,
    [minutes],
  );
  for (const r of quiet.rows) {
    // a very low last reading usually means the phone simply ran out of battery and switched off
    const hint = r.battery != null && r.battery <= 10 ? ` (last battery reading ${r.battery}%, the phone may have switched off)` : '';
    await raiseAlert(r.worker_id, 'offline', 'critical', `%worker% has not reported a location for ${minutes}+ minutes${hint}`, { condition: true });
  }

  // Came back
  const back = await pool.query<{ worker_id: number }>(
    `UPDATE alerts a SET resolved_at = now()
     FROM worker_last_location l
     WHERE a.worker_id = l.worker_id AND a.type = 'offline' AND a.resolved_at IS NULL
       AND l.recorded_at >= now() - make_interval(mins => $1)
     RETURNING a.worker_id`,
    [minutes],
  );
  for (const r of back.rows) broadcast({ type: 'alert-resolved', workerId: r.worker_id, alertType: 'offline' });

  // Spoofing alerts re-arm after 6h so one flagged day doesn't stay open forever
  await pool.query(`UPDATE alerts SET resolved_at = now() WHERE type = 'mock_location' AND resolved_at IS NULL AND created_at < now() - interval '6 hours'`);
}
