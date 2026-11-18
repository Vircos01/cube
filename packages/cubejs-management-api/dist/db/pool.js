"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPoolConfig = getPoolConfig;
exports.createPool = createPool;
exports.getOrCreatePool = getOrCreatePool;
exports.closePool = closePool;
exports.withTransaction = withTransaction;
const pg_1 = require("pg");
let globalPool = null;
function getPoolConfig(config) {
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
function createPool(config) {
    const poolConfig = getPoolConfig(config);
    return new pg_1.Pool(poolConfig);
}
function getOrCreatePool(config) {
    if (!globalPool) {
        globalPool = createPool(config);
    }
    return globalPool;
}
async function closePool() {
    if (globalPool) {
        await globalPool.end();
        globalPool = null;
    }
}
async function withTransaction(pool, callback) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    }
    catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
    finally {
        client.release();
    }
}
//# sourceMappingURL=pool.js.map