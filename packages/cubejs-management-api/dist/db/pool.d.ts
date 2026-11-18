import { Pool, PoolConfig, PoolClient } from 'pg';
import { DatabaseConfig } from '../types';
export declare function getPoolConfig(config?: DatabaseConfig): PoolConfig;
export declare function createPool(config?: DatabaseConfig): Pool;
export declare function getOrCreatePool(config?: DatabaseConfig): Pool;
export declare function closePool(): Promise<void>;
export declare function withTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T>;
//# sourceMappingURL=pool.d.ts.map