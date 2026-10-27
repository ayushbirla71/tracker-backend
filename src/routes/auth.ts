import bcrypt from 'bcryptjs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';

/** preHandler for admin-only routes. */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}

/**
 * preHandler for actions only the system admin may do (managing admins, changing passwords).
 * Checked against the database on every call, not the token, so a demoted or deleted account loses access at once.
 */
export async function requireSystemAdmin(req: FastifyRequest, reply: FastifyReply) {
  const denied = await requireAdmin(req, reply);
  if (denied) return denied;
  const me = Number((req.user as { sub: string }).sub);
  const { rows } = await pool.query<{ is_system: boolean }>('SELECT is_system FROM admins WHERE id = $1', [me]);
  if (!rows[0]?.is_system) return reply.code(403).send({ error: 'only the system administrator can do this' });
}

const loginBody = z.object({ email: z.string().min(1), password: z.string().min(1) });

export async function authRoutes(app: FastifyInstance) {
  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { email, password } = loginBody.parse(req.body);
      const { rows } = await pool.query<{ id: number; name: string; email: string; is_system: boolean; password_hash: string }>(
        'SELECT id, name, email, is_system, password_hash FROM admins WHERE lower(email) = lower($1)',
        [email],
      );
      const admin = rows[0];
      // compare even when the user is unknown so response time doesn't reveal which emails exist
      const ok = await bcrypt.compare(password, admin?.password_hash ?? '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi');
      if (!admin || !ok) return reply.code(401).send({ error: 'invalid email or password' });
      const token = app.jwt.sign({ sub: String(admin.id), email: admin.email }, { expiresIn: '12h' });
      return { token, admin: { id: admin.id, name: admin.name, email: admin.email, is_system: admin.is_system } };
    },
  );

  app.get('/auth/me', { preHandler: requireAdmin }, async (req) => {
    const { sub } = req.user as { sub: string };
    const { rows } = await pool.query('SELECT id, name, email, is_system FROM admins WHERE id = $1', [Number(sub)]);
    return rows[0] ?? null;
  });
}
