/**
 * Creates the system admin, or resets it if one already exists. Use this when the .env seed was never used,
 * or the system admin forgot their password (it cannot be reset from the website).
 *
 *   npm run system-admin -- <email> <password> [name]
 */
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const [email, password, name] = process.argv.slice(2);
if (!email || !password) {
  console.error('usage: npm run system-admin -- <email> <password> [name]');
  process.exit(1);
}
if (!/\S+@\S+\.\S+/.test(email)) {
  console.error('error: first argument must be an email address');
  process.exit(1);
}
if (password.length < 8) {
  console.error('error: password must be at least 8 characters');
  process.exit(1);
}

try {
  await migrate();
  const hash = await bcrypt.hash(password, 10);
  const existing = await pool.query<{ id: number }>('SELECT id FROM admins WHERE is_system');
  if (existing.rows[0]) {
    await pool.query('UPDATE admins SET email = lower($2), name = COALESCE($3, name), password_hash = $4 WHERE id = $1', [existing.rows[0].id, email, name ?? null, hash]);
    console.log(`system admin updated: ${email}`);
  } else {
    // the email may already belong to a web-created admin: promote that account instead of failing on the unique email
    const sameEmail = await pool.query<{ id: number }>('SELECT id FROM admins WHERE lower(email) = lower($1)', [email]);
    if (sameEmail.rows[0]) {
      await pool.query('UPDATE admins SET is_system = TRUE, name = COALESCE($2, name), password_hash = $3 WHERE id = $1', [sameEmail.rows[0].id, name ?? null, hash]);
    } else {
      await pool.query('INSERT INTO admins (name, email, password_hash, is_system) VALUES ($1, lower($2), $3, TRUE)', [name ?? 'System Administrator', email, hash]);
    }
    console.log(`system admin created: ${email}`);
  }
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
