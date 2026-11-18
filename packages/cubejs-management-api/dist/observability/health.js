"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.performHealthCheck = performHealthCheck;
const modelStore_1 = require("../repository/modelStore");
async function performHealthCheck(pool) {
    const start = Date.now();
    let dbConnected = false;
    let latencyMs = 0;
    let dbError;
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
        version = await (0, modelStore_1.getSchemaVersion)(pool);
    }
    catch (err) {
        dbConnected = false;
        dbError = err.message;
    }
    const poolStatus = {
        totalCount: pool.totalCount || 0,
        idleCount: pool.idleCount || 0,
        waitingCount: pool.waitingCount || 0,
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
//# sourceMappingURL=health.js.map