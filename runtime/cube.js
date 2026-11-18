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
    console.log('✨ VAS (Voxel Analytics Service) Web-UI running on http://localhost:4001/admin');
  }).catch(err => {
    console.error('Failed to start Management Server:', err);
  });
} catch (e) {
  console.warn('Note: Management Server could not be loaded directly:', e.message);
}

module.exports = {
  // Dynamic driverFactory supporting multi-database / external data sources
  driverFactory: async (context) => {
    const dataSource = context.dataSource || 'default';
    if (dataSource === 'default') {
      return {
        type: process.env.CUBEJS_DB_TYPE || 'postgres',
        host: process.env.CUBEJS_DB_HOST || 'localhost',
        port: parseInt(process.env.CUBEJS_DB_PORT || '5432', 10),
        database: process.env.CUBEJS_DB_NAME || 'cubedb',
        user: process.env.CUBEJS_DB_USER || 'postgres',
        password: process.env.CUBEJS_DB_PASS || 'postgres',
      };
    }

    try {
      const res = await pool.query('SELECT * FROM data_sources WHERE name = $1', [dataSource]);
      if (res.rows.length > 0) {
        const ds = res.rows[0];
        console.log(`[driverFactory] Resolving external data source '${dataSource}' -> ${ds.host}:${ds.port}/${ds.database_name}`);
        return {
          type: ds.db_type || 'postgres',
          host: ds.host,
          port: ds.port,
          database: ds.database_name,
          user: ds.username,
          password: ds.password,
          ssl: ds.ssl ? { rejectUnauthorized: false } : false,
        };
      }
      console.warn(`[driverFactory] Data source '${dataSource}' not found in metadata database, falling back to default`);
    } catch (err) {
      console.error(`[driverFactory] Error looking up data source '${dataSource}':`, err.message);
    }

    return {
      type: process.env.CUBEJS_DB_TYPE || 'postgres',
      host: process.env.CUBEJS_DB_HOST || 'localhost',
      port: parseInt(process.env.CUBEJS_DB_PORT || '5432', 10),
      database: process.env.CUBEJS_DB_NAME || 'cubedb',
      user: process.env.CUBEJS_DB_USER || 'postgres',
      password: process.env.CUBEJS_DB_PASS || 'postgres',
    };
  },

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
  },

  // 1. SQL-API Authentication Hook (PostgreSQL-wire protocol / Apache Superset / BI tools)
  checkSqlAuth: async (req, user, password) => {
    console.log(`[checkSqlAuth] Authenticating SQL user: '${user}'`);

    // Rol 1: Global Admin - volledige ongefilterde toegang
    if (user === 'admin' && password === 'admin') {
      return {
        password: 'admin',
        superuser: true,
        securityContext: {
          username: 'admin',
          name: 'Global Administrator',
          role: 'admin'
        }
      };
    }

    // Rol 2: Sales Rep Amsterdam - RLS actief (alleen Amsterdam), OLS actief (geen avg_order_value)
    if (user === 'sales_amsterdam' && password === 'amsterdam123') {
      return {
        password: 'amsterdam123',
        superuser: false,
        securityContext: {
          username: 'sales_amsterdam',
          name: 'Amsterdam Sales Representative',
          role: 'sales_rep',
          city: 'Amsterdam',
          denyMeasures: ['Orders.avg_order_value']
        }
      };
    }

    // Rol 3: Sales Rep Rotterdam - RLS actief (alleen Rotterdam)
    if (user === 'sales_rotterdam' && password === 'rotterdam123') {
      return {
        password: 'rotterdam123',
        superuser: false,
        securityContext: {
          username: 'sales_rotterdam',
          name: 'Rotterdam Sales Representative',
          role: 'sales_rep',
          city: 'Rotterdam'
        }
      };
    }

    // Fallback voor standaard cube user
    if (user === 'cube' && password === 'cube') {
      return {
        password: 'cube',
        superuser: true,
        securityContext: { role: 'admin', username: 'cube' }
      };
    }

    throw new Error(`[Authentication Failed] Ongeldige inloggegevens voor SQL user: '${user}'`);
  },

  // 2. QueryRewrite Hook: Dynamische RLS & OLS handhaving (werkt voor SQL-API én REST-API)
  queryRewrite: async (query, { securityContext }) => {
    // Admin heeft altijd volledige ongefilterde toegang
    if (!securityContext || securityContext.role === 'admin' || securityContext.superuser) {
      return query;
    }

    console.log(`[queryRewrite] Actieve beveiligingspolicy voor user: '${securityContext.username}', rol: '${securityContext.role}'`);

    // A. Object-Level Security (OLS): Kolommen / Maatstaven blokkeren voor niet-geautoriseerde rollen
    if (securityContext.denyMeasures && Array.isArray(securityContext.denyMeasures)) {
      const requestedMeasures = query.measures || [];
      for (const denied of securityContext.denyMeasures) {
        if (requestedMeasures.includes(denied)) {
          throw new Error(
            `[Access Denied] Maatstaf '${denied}' is afgeschermd (Object-Level Security) en niet toegankelijk voor rol '${securityContext.role}'.`
          );
        }
      }
    }

    // B. Row-Level Security (RLS): Data dynamisch filteren op rijniveau
    const allQueryMembers = [
      ...(query.measures || []),
      ...(query.dimensions || []),
      ...(query.segments || []),
      ...((query.filters || []).map(f => f.member || ''))
    ];
    const touchesOrdersOrUsers = allQueryMembers.some(m => m.startsWith('Orders.') || m.startsWith('Users.'));

    if (touchesOrdersOrUsers && securityContext.city) {
      query.filters = query.filters || [];
      query.filters.push({
        member: 'Users.city',
        operator: 'equals',
        values: [securityContext.city]
      });
      console.log(`[queryRewrite] RLS filter geactiveerd: Users.city = '${securityContext.city}'`);
    }

    return query;
  }
};
