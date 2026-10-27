import 'dotenv/config';
import { z } from 'zod';

const bool = z
  .string()
  .transform((v) => v.toLowerCase() === 'true')
  .or(z.boolean());

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string().default('postgres://tracker:tracker@localhost:15432/tracker'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),
  APP_KEY: z.string().min(8, 'APP_KEY must be at least 8 characters'),
  ADMIN_EMAIL: z.string().default('admin@demokrito.com'),
  ADMIN_PASSWORD: z.string().default('ChangeMe123!'),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  REQUIRE_DEVICE_APPROVAL: bool.default(true),
  STAY_RADIUS_M: z.coerce.number().default(50),
  STAY_MIN_SECONDS: z.coerce.number().default(300),
  MAX_ACCURACY_M: z.coerce.number().default(50),
  STAY_MAX_GAP_SECONDS: z.coerce.number().default(900),
  OFFLINE_ALERT_MINUTES: z.coerce.number().default(15),
  LOW_BATTERY_PERCENT: z.coerce.number().default(15),
  // Looks up a street address for each stop through OpenStreetMap Nominatim. Off by default because it sends
  // the coordinates of stops to that public service.
  REVERSE_GEOCODE: bool.default(false),
  // Where uploaded APK files are stored (relative paths are resolved from the backend folder). Back this folder up / mount it as a volume in production.
  UPLOADS_DIR: z.string().default('./uploads'),
  MAX_APK_MB: z.coerce.number().default(300),
  NOMINATIM_URL: z.string().default('https://nominatim.openstreetmap.org'),
  ONLINE_WINDOW_SECONDS: z.coerce.number().default(300),
  RETENTION_DAYS: z.coerce.number().default(90),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) console.error(` - ${issue.path.join('.')}: ${issue.message}`);
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
