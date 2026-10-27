import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { requireAdmin, requireSystemAdmin } from './auth.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const password = z.string().min(8, 'password must be at least 8 characters').max(200);

const createBody = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(200),
  password,
});

const changePasswordBody = z.object({ current_password: z.string().min(1), new_password: password });
const resetPasswordBody = z.object({ new_password: password });

/**
 * Account rules: one system admin, created by the seed / `npm run system-admin` (never from the website).
 * Admins created from the website are managed entirely by the system admin: only it can add them, remove them,
 * and set their passwords. They cannot change their own password.
 */
export async function accountRoutes(app: FastifyInstance) {
  app.get('/admins', { preHandler: requireAdmin }, async () => (await pool.query('SELECT id, name, email, is_system, created_at FROM admins ORDER BY is_system DESC, created_at')).rows);

  app.post('/admins', { preHandler: requireSystemAdmin }, async (req, reply) => {
    const b = createBody.parse(req.body);
    const hash = await bcrypt.hash(b.password, 10);
    try {
      const { rows } = await pool.query(
        'INSERT INTO admins (name, email, password_hash, is_system) VALUES ($1, lower($2), $3, FALSE) RETURNING id, name, email, is_system, created_at',
        [b.name, b.email, hash],
      );
      return reply.code(201).send(rows[0]);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') return reply.code(409).send({ error: 'an admin with this email already exists' });
      throw err;
    }
  });

  app.delete('/admins/:id', { preHandler: requireSystemAdmin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const target = await pool.query<{ is_system: boolean }>('SELECT is_system FROM admins WHERE id = $1', [id]);
    if (target.rows[0]?.is_system) return reply.code(400).send({ error: 'the system administrator cannot be removed' });
    await pool.query('DELETE FROM admins WHERE id = $1 AND NOT is_system', [id]);
    return reply.code(204).send();
  });

  /** Sets a new password for another admin (they cannot change it themselves). */
  app.post('/admins/:id/password', { preHandler: requireSystemAdmin, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = resetPasswordBody.parse(req.body);
    const { rowCount } = await pool.query('UPDATE admins SET password_hash = $2 WHERE id = $1', [id, await bcrypt.hash(b.new_password, 10)]);
    if (!rowCount) return reply.code(404).send({ error: 'admin not found' });
    return { ok: true };
  });

  /** The system admin changing their own password. */
  app.post('/auth/change-password', { preHandler: requireSystemAdmin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = changePasswordBody.parse(req.body);
    const me = Number((req.user as { sub: string }).sub);
    const { rows } = await pool.query<{ password_hash: string }>('SELECT password_hash FROM admins WHERE id = $1', [me]);
    if (!rows[0] || !(await bcrypt.compare(b.current_password, rows[0].password_hash))) return reply.code(400).send({ error: 'current password is wrong' });
    await pool.query('UPDATE admins SET password_hash = $2 WHERE id = $1', [me, await bcrypt.hash(b.new_password, 10)]);
    return { ok: true };
  });
}
