const { Pool } = require('pg');
const path = require('path');

const pool = new Pool({
  host: process.env.CUBEJS_DB_HOST || 'localhost',
  port: parseInt(process.env.CUBEJS_DB_PORT || '5432', 10),
  user: process.env.CUBEJS_DB_USER || 'postgres',
  password: process.env.CUBEJS_DB_PASS || 'postgres',
  database: process.env.CUBEJS_DB_NAME || 'cubedb',
});

// Start Management API & Web-UI on port 4001
try {
  const { startManagementServer } = require('/management-api/dist');
  startManagementServer({
    port: parseInt(process.env.MANAGEMENT_PORT || '4001', 10),
    pool,
    apiSecret: process.env.CUBEJS_API_SECRET || 'mysecretkey123'
  }).then(() => {
    console.log('✨ Cube Core Semantic Web-UI running on http://localhost:4001/admin');
  }).catch(err => {
    console.error('Failed to start Management Server:', err);
  });
} catch (e) {
  console.warn('Note: Management Server could not be loaded directly:', e.message);
}

module.exports = {
  // Custom repositoryFactory fetching active YAML definitions from PostgreSQL
  repositoryFactory: (context) => ({
    localPath: () => '/cube/conf/schema',
    dataSchemaFiles: async () => {
      try {
        const res = await pool.query(`
          SELECT sm.file_name, mr.content
          FROM semantic_models sm
          JOIN model_revisions mr ON sm.id = mr.model_id
          WHERE sm.is_active = true AND mr.status = 'active'
          ORDER BY sm.name ASC
        `);
        return res.rows.map(row => ({
          fileName: row.file_name,
          content: row.content,
          readOnly: false,
        }));
      } catch (err) {
        console.error('[repositoryFactory] Error fetching models from PostgreSQL:', err.message);
        return [];
      }
    }
  }),

  // schemaVersion hook for atomic zero-downtime hot-reload
  schemaVersion: async (context) => {
    try {
      const res = await pool.query('SELECT version, version_hash, updated_at FROM schema_version_tracker WHERE id = 1');
      if (res.rows.length === 0) {
        return 'v1_initial';
      }
      const row = res.rows[0];
      return `v${row.version}_${row.version_hash}_${new Date(row.updated_at).getTime()}`;
    } catch (err) {
      console.error('[schemaVersion] Error reading version tracker:', err.message);
      return 'fallback_version';
    }
  }
};
