import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import { createManagementRouter } from './router';
import { getOrCreatePool } from '../db/pool';
import { runMigrations } from '../db/migrator';

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
    console.log('✓ Metadata tables and sample data initialized in PostgreSQL');
  } catch (err: any) {
    console.warn('Note on migrations:', err.message);
  }

  const app = express();
  app.use(cors(options.corsOrigin ? { origin: options.corsOrigin } : { origin: '*' }));
  app.use(express.json({ limit: '10mb' }));

  // Mount management router
  app.use('/management/v1', createManagementRouter(pool, { apiSecret: options.apiSecret }));
  // Mount web-ui directly on /admin
  app.use('/', createManagementRouter(pool, { apiSecret: options.apiSecret }));

  const server = app.listen(port, () => {
    console.log(`🚀 Cube Management API & Web-UI running on http://localhost:${port}/admin`);
  });

  return { app, server, pool };
}
