import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { Pool } from 'pg';
import { createManagementRouter } from './router';
import { getOrCreatePool } from '../db/pool';
import { runMigrations } from '../db/migrator';
import { logger, redactSensitiveData } from '../observability/logger';
import { metrics } from '../observability/metrics';

export interface ManagementServerOptions {
  port?: number;
  apiSecret?: string;
  pool?: Pool;
  corsOrigin?: string | boolean;
}

export async function startManagementServer(options: ManagementServerOptions = {}) {
  const port = options.port || (process.env.MANAGEMENT_PORT ? parseInt(process.env.MANAGEMENT_PORT, 10) : 4001);
  const pool = options.pool || getOrCreatePool();

  // Run migrations
  try {
    await runMigrations(pool, { includeSampleData: true });
    logger.info('✓ Metadata tables and sample data initialized in PostgreSQL');
  } catch (err: any) {
    logger.warn('Note on migrations:', err.message);
  }

  const app = express();
  app.use(cors(options.corsOrigin ? { origin: options.corsOrigin } : { origin: '*' }));
  app.use(express.json({ limit: '10mb' }));

  // 1. Correlation ID & Structured Request Logging Middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const rawId = req.headers['x-request-id'] || req.headers['x-correlation-id'];
    const requestId = (typeof rawId === 'string' && rawId.trim()) ? rawId.trim() : crypto.randomUUID();

    (req as any).id = requestId;
    res.setHeader('X-Request-Id', requestId);

    const startTime = Date.now();

    res.on('finish', () => {
      const durationMs = Date.now() - startTime;
      const routePath = req.baseUrl + (req.route?.path || req.path);
      const isStatic = req.path.startsWith('/admin') && (req.path.endsWith('.js') || req.path.endsWith('.css') || req.path.endsWith('.png'));

      metrics.recordRequest(req.method, routePath, res.statusCode, durationMs);

      if (!isStatic) {
        logger.info(`${req.method} ${req.path} -> ${res.statusCode} (${durationMs}ms)`, {
          type: 'http_access',
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs,
          userAgent: req.headers['user-agent'],
        });
      }
    });

    logger.runWithContext({ requestId }, () => next());
  });

  // Mount management router
  app.use('/management/v1', createManagementRouter(pool, { apiSecret: options.apiSecret }));
  // Mount web-ui directly on /admin
  app.use('/', createManagementRouter(pool, { apiSecret: options.apiSecret }));

  // 2. Safe Global Error Handler (Fase 5: Geen credential leaks / sanitized errors in production)
  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    const requestId = (req as any).id;
    logger.error(`Unhandled API error on ${req.method} ${req.path}: ${err.message}`, err);

    if (res.headersSent) {
      return next(err);
    }

    const statusCode = err.status || err.statusCode || 500;
    const isProd = process.env.NODE_ENV === 'production';

    res.status(statusCode).json({
      error: isProd ? 'Internal Server Error' : err.message,
      requestId,
      ...(isProd ? {} : { stack: err.stack }),
      ...(err.code ? { code: err.code } : {}),
      ...(err.validationErrors ? { validationErrors: err.validationErrors } : {}),
    });
  });

  const server = app.listen(port, () => {
    logger.info(`🚀 VAS (Voxel Analytics Service) Web-UI running on http://localhost:${port}/admin`);
  });

  return { app, server, pool };
}
