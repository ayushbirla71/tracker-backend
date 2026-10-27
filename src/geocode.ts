import { config } from './config.js';
import { pool } from './db.js';

/**
 * Fills in `stays.address` using OpenStreetMap Nominatim (usage policy: max 1 request/second, identify the app).
 * One stay per call, newest first, so a backlog never hammers the public server.
 * A failed lookup stores '' so the same stay isn't retried forever.
 */
export async function geocodeNextStay(): Promise<boolean> {
  const { rows } = await pool.query<{ id: string; lat: number; lng: number }>(
    `SELECT id, lat, lng FROM stays
     WHERE address IS NULL AND NOT is_open
     ORDER BY start_at DESC LIMIT 1`,
  );
  const stay = rows[0];
  if (!stay) return false;

  let address = '';
  try {
    const url = `${config.NOMINATIM_URL}/reverse?format=jsonv2&zoom=18&lat=${stay.lat}&lon=${stay.lng}`;
    const res = await fetch(url, { headers: { 'user-agent': 'ad96-tracker/1.0 (self-hosted)', 'accept-language': 'en' }, signal: AbortSignal.timeout(10_000) });
    if (res.ok) {
      const body = (await res.json()) as { display_name?: string };
      address = body.display_name ?? '';
    }
  } catch {
    // leave empty
  }
  await pool.query('UPDATE stays SET address = $2 WHERE id = $1', [stay.id, address]);
  return true;
}
