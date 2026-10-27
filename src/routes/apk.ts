import multipart from '@fastify/multipart';
import type { FastifyInstance } from 'fastify';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { z } from 'zod';
import { createDownloadToken, looksLikeApk, verifyDownloadToken } from '../apk.js';
import { config } from '../config.js';
import { pool } from '../db.js';
import { requireAdmin, requireSystemAdmin } from './auth.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

const apkDir = () => path.resolve(config.UPLOADS_DIR, 'apk');
const apkPath = (id: number) => path.join(apkDir(), `${id}.apk`);
const quietUnlink = (p: string) => unlink(p).catch(() => undefined);

const metaSchema = z.object({
  version_name: z.string().trim().min(1, 'version is required').max(50),
  notes: z.string().trim().max(2000).optional(),
});

export async function apkRoutes(app: FastifyInstance) {
  await app.register(multipart, { limits: { fileSize: config.MAX_APK_MB * 1024 * 1024, files: 1, fields: 5, fieldSize: 8 * 1024 } });

  app.get('/app/releases', { preHandler: requireAdmin }, async () => {
    const { rows } = await pool.query(
      `SELECT r.id, r.version_name, r.notes, r.size_bytes::float8 AS size_bytes, r.sha256, r.created_at, a.name AS uploaded_by
       FROM app_releases r LEFT JOIN admins a ON a.id = r.uploaded_by
       ORDER BY r.created_at DESC, r.id DESC`,
    );
    return rows;
  });

  /** Upload a new build. System admin only: whatever is uploaded here gets installed on workers' phones. */
  app.post('/app/releases', { preHandler: requireSystemAdmin, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    if (!req.isMultipart()) throw httpError(400, 'send the file as multipart/form-data');
    await mkdir(apkDir(), { recursive: true });
    const tmp = path.join(apkDir(), `upload-${randomUUID()}.tmp`);

    try {
      const fields: Record<string, string> = {};
      const hash = createHash('sha256');
      let size = 0;
      let received = false;

      for await (const part of req.parts()) {
        if (part.type === 'field') {
          if (typeof part.value === 'string') fields[part.fieldname] = part.value;
          continue;
        }
        if (received) {
          part.file.resume();
          throw httpError(400, 'upload one file at a time');
        }
        if (!/\.apk$/i.test(part.filename)) {
          part.file.resume();
          throw httpError(400, 'the file must be an .apk');
        }
        received = true;
        const meter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            hash.update(chunk);
            size += chunk.length;
            cb(null, chunk);
          },
        });
        await pipeline(part.file, meter, createWriteStream(tmp)); // over the size limit this rejects with a 413
      }

      if (!received || size === 0) throw httpError(400, 'choose an .apk file to upload');
      const parsed = metaSchema.safeParse(fields);
      if (!parsed.success) throw httpError(400, parsed.error.issues[0]?.message ?? 'invalid details');
      if (!(await looksLikeApk(tmp))) throw httpError(400, 'this does not look like an Android app (.apk) file');

      const me = Number((req.user as { sub: string }).sub);
      const { rows } = await pool.query(
        `INSERT INTO app_releases (version_name, notes, size_bytes, sha256, uploaded_by) VALUES ($1, $2, $3, $4, $5)
         RETURNING id, version_name, notes, size_bytes::float8 AS size_bytes, sha256, created_at`,
        [parsed.data.version_name, parsed.data.notes || null, size, hash.digest('hex'), me],
      );
      const release = rows[0];
      try {
        await rename(tmp, apkPath(release.id));
      } catch (err) {
        await pool.query('DELETE FROM app_releases WHERE id = $1', [release.id]);
        throw err;
      }
      return reply.code(201).send(release);
    } catch (err) {
      await quietUnlink(tmp);
      throw err;
    }
  });

  app.delete('/app/releases/:id', { preHandler: requireSystemAdmin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await pool.query('DELETE FROM app_releases WHERE id = $1', [id]);
    await quietUnlink(apkPath(id));
    return reply.code(204).send();
  });

  /** A short-lived link for this release: used by the Download button and shown as a QR code for installing from a phone. */
  app.post('/app/releases/:id/link', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { rowCount } = await pool.query('SELECT 1 FROM app_releases WHERE id = $1', [id]);
    if (!rowCount) return reply.code(404).send({ error: 'release not found' });
    const { token, expiresAt } = createDownloadToken(id);
    return { path: `/app/download/${token}`, expires_at: expiresAt };
  });

  app.get('/app/download/:token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { token } = z.object({ token: z.string().max(200) }).parse(req.params);
    const id = verifyDownloadToken(token);
    if (id == null) return reply.code(403).send({ error: 'this download link is invalid or has expired - open the app page and get a new one' });

    const { rows } = await pool.query<{ version_name: string }>('SELECT version_name FROM app_releases WHERE id = $1', [id]);
    const release = rows[0];
    if (!release) return reply.code(404).send({ error: 'release not found' });
    const file = await stat(apkPath(id)).catch(() => null);
    if (!file) return reply.code(404).send({ error: 'the file for this release is missing on the server' });

    const filename = `ad96-tracker-${release.version_name.replace(/[^\w.-]+/g, '-')}.apk`;
    return reply
      .header('content-type', 'application/vnd.android.package-archive')
      .header('content-length', file.size)
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .send(createReadStream(apkPath(id)));
  });
}
