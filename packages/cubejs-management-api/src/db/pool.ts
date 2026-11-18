import { Pool, PoolConfig, PoolClient } from 'pg';
import { DatabaseConfig } from '../types';

let globalPool: Pool | null = null;

export function getPoolConfig(config?: DatabaseConfig): PoolConfig {
  if (config?.connectionString) {
    return {
      connectionString: config.connectionString,
      ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
      max: config.max || 10,
    };
  }

  return {
    host: config?.host || process.env.CUBEJS_DB_HOST || 'localhost',
    port: config?.port || (process.env.CUBEJS_DB_PORT ? parseInt(process.env.CUBEJS_DB_PORT, 10) : 5432),
    user: config?.user || process.env.CUBEJS_DB_USER || 'postgres',
    password: config?.password || process.env.CUBEJS_DB_PASS || 'postgres',
    database: config?.database || process.env.CUBEJS_DB_NAME || 'cubedb',
    ssl: config?.ssl ? { rejectUnauthorized: false } : undefined,
    max: config?.max || 10,
  };
}

export function createPool(config?: DatabaseConfig): Pool {
  const poolConfig = getPoolConfig(config);
  return new Pool(poolConfig);
}

export function getOrCreatePool(config?: DatabaseConfig): Pool {
  if (!globalPool) {
    globalPool = createPool(config);
  }
  return globalPool;
}

export async function closePool(): Promise<void> {
  if (globalPool) {
    await globalPool.end();
    globalPool = null;
  }
}

export async function withTransaction<T>(
  pool: Pool,
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
