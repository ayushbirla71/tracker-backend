/**
 * Pretends to be a worker phone so the whole pipeline can be tried without a device.
 *
 *   npm run simulate -- [device_id] [hours]
 *
 * Generates `hours` (default 6) of history ending now, uploaded in batches: the worker drives between a few stops
 * in Pune, standing ~15-40 min at each, then keeps sending a live point every 5 s.
 */
import 'dotenv/config';

const API = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const APP_KEY = process.env.APP_KEY ?? '';
const deviceId = process.argv[2] ?? 'sim-device-0001';
const hours = Number(process.argv[3] ?? 6);

const stops = [
  { lat: 18.5204, lng: 73.8567 },
  { lat: 18.5314, lng: 73.8446 },
  { lat: 18.5018, lng: 73.8636 },
  { lat: 18.5593, lng: 73.7868 },
  { lat: 18.5362, lng: 73.8940 },
];

const headers = { 'content-type': 'application/json', 'x-app-key': APP_KEY };
const jitter = () => (Math.random() - 0.5) * 0.00006; // ~3 m of GPS noise

async function post(path: string, body: unknown) {
  const res = await fetch(`${API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

interface Pt { t: number; lat: number; lng: number; accuracy: number; speed: number; battery: number }

function buildHistory(): Pt[] {
  const pts: Pt[] = [];
  let t = Date.now() - hours * 3600_000;
  let battery = 100;
  let stopIdx = 0;
  while (t < Date.now() - 60_000) {
    const here = stops[stopIdx % stops.length]!;
    const next = stops[(stopIdx + 1) % stops.length]!;
    const stayMin = 15 + Math.random() * 25;
    for (let s = 0; s < stayMin * 60 && t < Date.now(); s += 30, t += 30_000) {
      pts.push({ t, lat: here.lat + jitter(), lng: here.lng + jitter(), accuracy: 6, speed: 0, battery: Math.round(battery) });
      battery -= 0.01;
    }
    const steps = 40; // ~10-15 min driving
    for (let i = 1; i <= steps && t < Date.now(); i++, t += 20_000) {
      pts.push({
        t,
        lat: here.lat + ((next.lat - here.lat) * i) / steps + jitter(),
        lng: here.lng + ((next.lng - here.lng) * i) / steps + jitter(),
        accuracy: 8,
        speed: 8,
        battery: Math.round(battery),
      });
      battery -= 0.01;
    }
    stopIdx++;
  }
  return pts;
}

const reg = await post('/devices/register', { device_id: deviceId, model: 'Simulator', os: 'Android 14', app_version: '0.0.0-sim' });
console.log('register ->', reg.status, reg.body);
if (reg.body.status !== 'active') {
  console.log('Device is not active yet: approve it in the admin website (Devices page), then run this again.');
  process.exit(0);
}

const history = buildHistory();
console.log(`uploading ${history.length} points of history...`);
for (let i = 0; i < history.length; i += 200) {
  const r = await post('/locations/batch', { device_id: deviceId, points: history.slice(i, i + 200) });
  if (r.status !== 200) {
    console.error('upload failed', r.status, r.body);
    process.exit(1);
  }
}
console.log('history uploaded. Sending live points every 5 s (Ctrl+C to stop)...');

const last = history[history.length - 1]!;
let step = 0;
setInterval(async () => {
  step++;
  const r = await post('/locations/batch', {
    device_id: deviceId,
    points: [{ t: Date.now(), lat: last.lat + step * 0.00004, lng: last.lng + step * 0.00004, accuracy: 7, speed: 5, battery: last.battery }],
  });
  console.log('live', step, r.status, r.body);
}, 5000);
