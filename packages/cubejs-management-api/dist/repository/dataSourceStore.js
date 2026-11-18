"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertDataSource = upsertDataSource;
exports.getDataSource = getDataSource;
exports.getSafeDataSource = getSafeDataSource;
exports.listDataSources = listDataSources;
exports.deleteDataSource = deleteDataSource;
async function upsertDataSource(pool, input) {
    const dbType = input.db_type || 'postgres';
    const schemaName = input.schema_name || 'public';
    const ssl = !!input.ssl;
    const res = await pool.query(`
    INSERT INTO data_sources (name, db_type, host, port, database_name, username, password, schema_name, ssl, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    ON CONFLICT (name) DO UPDATE SET
      db_type = EXCLUDED.db_type,
      host = EXCLUDED.host,
      port = EXCLUDED.port,
      database_name = EXCLUDED.database_name,
      username = EXCLUDED.username,
      password = CASE 
        WHEN EXCLUDED.password IS NOT NULL AND EXCLUDED.password <> '' THEN EXCLUDED.password 
        ELSE data_sources.password 
      END,
      schema_name = EXCLUDED.schema_name,
      ssl = EXCLUDED.ssl,
      updated_at = NOW()
    RETURNING *
  `, [
        input.name,
        dbType,
        input.host,
        input.port,
        input.database_name,
        input.username,
        input.password || '',
        schemaName,
        ssl,
    ]);
    return res.rows[0];
}
async function getDataSource(pool, idOrName) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrName);
    const query = isUuid
        ? 'SELECT * FROM data_sources WHERE id = $1'
        : 'SELECT * FROM data_sources WHERE name = $1';
    const res = await pool.query(query, [idOrName]);
    if (res.rows.length === 0) {
        return null;
    }
    return res.rows[0];
}
async function getSafeDataSource(pool, idOrName) {
    const ds = await getDataSource(pool, idOrName);
    if (!ds) {
        return null;
    }
    const { password, ...safe } = ds;
    return {
        ...safe,
        hasPassword: !!password,
    };
}
async function listDataSources(pool) {
    const res = await pool.query('SELECT id, name, db_type, host, port, database_name, username, schema_name, ssl, created_at, updated_at FROM data_sources ORDER BY name ASC');
    return res.rows;
}
async function deleteDataSource(pool, idOrName) {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrName);
    const query = isUuid
        ? 'DELETE FROM data_sources WHERE id = $1 RETURNING id'
        : 'DELETE FROM data_sources WHERE name = $1 RETURNING id';
    const res = await pool.query(query, [idOrName]);
    return res.rows.length > 0;
}
//# sourceMappingURL=dataSourceStore.js.map