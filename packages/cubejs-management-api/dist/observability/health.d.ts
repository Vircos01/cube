import { Pool } from 'pg';
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
export declare function performHealthCheck(pool: Pool): Promise<HealthCheckResult>;
//# sourceMappingURL=health.d.ts.map