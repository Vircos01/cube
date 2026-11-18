import { Pool } from 'pg';
import { getSchemaVersion } from '../repository/modelStore';

export interface HealthCheckResult {
  status: 'ok' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptimeSeconds: number;
  schemaVersion: string;
  database: {
    connected: boolean;
    latencyMs: number;
    pool: {
      totalCount: number;
      idleCount: number;
      waitingCount: number;
    };
    error?: string;
  };
  models?: {
    activeCount: number;
  };
}

export async function performHealthCheck(pool: Pool): Promise<HealthCheckResult> {
  const start = Date.now();
  let dbConnected = false;
  let latencyMs = 0;
  let dbError: string | undefined;
  let activeModelsCount = 0;
  let version = 'unknown';

  try {
    const pingStart = Date.now();
    await pool.query('SELECT 1');
    latencyMs = Date.now() - pingStart;
    dbConnected = true;

    // Get active models count
    const modelsRes = await pool.query('SELECT count(*) AS count FROM semantic_models WHERE is_active = true');
    activeModelsCount = parseInt(modelsRes.rows[0]?.count || '0', 10);

    // Get schema version
    version = await getSchemaVersion(pool);
  } catch (err: any) {
    dbConnected = false;
    dbError = err.message;
  }

  const poolStatus = {
    totalCount: (pool as any).totalCount || 0,
    idleCount: (pool as any).idleCount || 0,
    waitingCount: (pool as any).waitingCount || 0,
  };

  const isHealthy = dbConnected;

  return {
    status: isHealthy ? 'ok' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    schemaVersion: version,
    database: {
      connected: dbConnected,
      latencyMs,
      pool: poolStatus,
      ...(dbError ? { error: dbError } : {}),
    },
    models: {
      activeCount: activeModelsCount,
    },
  };
}
