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
    const max = config?.max || (process.env.PG_POOL_MAX ? parseInt(process.env.PG_POOL_MAX, 10) : 20);
    const connectionTimeoutMillis = config?.connectionTimeoutMillis || (process.env.PG_CONN_TIMEOUT_MS ? parseInt(process.env.PG_CONN_TIMEOUT_MS, 10) : 5000);
    const idleTimeoutMillis = config?.idleTimeoutMillis || (process.env.PG_IDLE_TIMEOUT_MS ? parseInt(process.env.PG_IDLE_TIMEOUT_MS, 10) : 30000);
    const statement_timeout = config?.statement_timeout || (process.env.PG_STATEMENT_TIMEOUT_MS ? parseInt(process.env.PG_STATEMENT_TIMEOUT_MS, 10) : 30000);
    if (config?.connectionString) {
        return {
            connectionString: config.connectionString,
            ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
            max,
            connectionTimeoutMillis,
            idleTimeoutMillis,
            statement_timeout,
        };
    }
    return {
        host: config?.host || process.env.CUBEJS_DB_HOST || 'localhost',
        port: config?.port || (process.env.CUBEJS_DB_PORT ? parseInt(process.env.CUBEJS_DB_PORT, 10) : 5432),
        user: config?.user || process.env.CUBEJS_DB_USER || 'postgres',
        password: config?.password || process.env.CUBEJS_DB_PASS || 'postgres',
        database: config?.database || process.env.CUBEJS_DB_NAME || 'cubedb',
        ssl: config?.ssl ? { rejectUnauthorized: false } : undefined,
        max,
        connectionTimeoutMillis,
        idleTimeoutMillis,
        statement_timeout,
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