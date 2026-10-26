import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config, providerStatus } from './config.js';
import { chatRouter } from './routes/chat.js';
import { diagnoseRouter } from './routes/diagnose.js';

const app = express();
const startedAt = Date.now();

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(
  cors({
    origin: (origin, callback) => {
      // Same-origin requests (the built client) have no Origin header.
      if (!origin) return callback(null, true);
      if (config.allowedOrigins.includes(origin) || config.allowedOrigins.includes('*')) return callback(null, true);
      return callback(null, false);
    },
  }),
);
app.use(express.json({ limit: '1mb' }));

/** Small in-memory limiter: enough to stop accidental abuse on a demo deploy. */
const WINDOW_MS = 60_000;
const MAX_REQUESTS = 40;
const hits = new Map<string, number[]>();

app.use('/api', (req, res, next) => {
  const key = req.ip ?? 'unknown';
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((time) => now - time < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) {
    res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    return;
  }
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5_000) {
    for (const [ip, times] of hits) {
      if (times.every((time) => now - time > WINDOW_MS)) hits.delete(ip);
    }
  }
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    provider: providerStatus(),
    version: '1.0.0',
  });
});

app.use('/api', diagnoseRouter);
app.use('/api', chatRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Unknown API route.' });
});

// In production the API serves the built client, so one process deploys both.
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist, { maxAge: '1h', index: false }));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ error: 'Request body must be valid JSON.' });
    return;
  }
  console.error('[authdoctor] unhandled error:', error instanceof Error ? error.message : error);
  res.status(500).json({
    error: 'Internal server error.',
    ...(config.nodeEnv !== 'production' && error instanceof Error ? { detail: error.message } : {}),
  });
});

app.listen(config.port, () => {
  const provider = providerStatus();
  console.log(`AuthDoctor API listening on http://localhost:${config.port}`);
  console.log(
    provider.mode === 'model'
      ? `Model mode: ${provider.model} via ${provider.baseUrlHost}`
      : 'Local mode: no AI_BASE_URL/AI_MODEL configured, using the deterministic engine',
  );
});
