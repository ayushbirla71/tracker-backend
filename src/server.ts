import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { config } from './config.js';
import { addLiveClient } from './live.js';
import { accountRoutes } from './routes/accounts.js';
import { adminRoutes } from './routes/admin.js';
import { apkRoutes } from './routes/apk.js';
import { insightRoutes } from './routes/insights.js';
import { authRoutes } from './routes/auth.js';
import { deviceRoutes } from './routes/device.js';
import { reportRoutes } from './routes/reports.js';

export async function buildServer() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    bodyLimit: 2 * 1024 * 1024,
    trustProxy: config.TRUST_PROXY,
    // The website and the app call <address>/api/...; some proxies / tunnels forward that path untouched. Accept it, so the API
    // works both when the proxy removes the /api prefix (our Caddy) and when it does not (nginx without a trailing slash, ngrok, ...).
    rewriteUrl: (req) => {
      const url = req.url ?? '/';
      return url === '/api' || url.startsWith('/api/') || url.startsWith('/api?') ? url.slice(4) || '/' : url;
    },
  });

  await app.register(cors, {
    origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',').map((o) => o.trim()),
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  await app.register(rateLimit, { global: false });
  await app.register(jwt, { secret: config.JWT_SECRET });
  await app.register(websocket);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation failed', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'internal server error' : (err as Error).message });
  });

  app.get('/health', async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(deviceRoutes);
  await app.register(adminRoutes);
  await app.register(insightRoutes);
  await app.register(accountRoutes);
  await app.register(apkRoutes);
  await app.register(reportRoutes);

  // Live feed for the admin website. Browsers can't set headers on WebSockets, so the JWT comes in the query string.
  app.get('/ws/admin', { websocket: true }, (socket, req) => {
    const token = (req.query as { token?: string }).token;
    try {
      if (!token) throw new Error('missing token');
      app.jwt.verify(token);
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }
    addLiveClient(socket);
    socket.send(JSON.stringify({ type: 'hello' }));
  });

  return app;
}
