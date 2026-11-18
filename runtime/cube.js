const { Pool } = require('pg');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const pool = new Pool({
  host: process.env.CUBEJS_DB_HOST || 'localhost',
  port: parseInt(process.env.CUBEJS_DB_PORT || '5432', 10),
  user: process.env.CUBEJS_DB_USER || 'postgres',
  password: process.env.CUBEJS_DB_PASS || 'postgres',
  database: process.env.CUBEJS_DB_NAME || 'cubedb',
  max: parseInt(process.env.PG_POOL_MAX || '20', 10),
  idleTimeoutMillis: parseInt(process.env.PG_IDLE_TIMEOUT_MS || '30000', 10),
  connectionTimeoutMillis: parseInt(process.env.PG_CONN_TIMEOUT_MS || '5000', 10),
  statement_timeout: parseInt(process.env.PG_STATEMENT_TIMEOUT_MS || '30000', 10),
});

// Helper for constant-time password verification using scrypt
function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  if (storedHash.startsWith('scrypt:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 3) return false;
    const [, salt, hash] = parts;
    const computed = crypto.scryptSync(password, salt, 64).toString('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
    } catch {
      return false;
    }
  }
  // Constant-time compare fallback for demo/seed passwords
  try {
    const a = Buffer.from(password);
    const b = Buffer.from(storedHash);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

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
        console.error('[repositoryFactory] CRITICAL: Fout bij ophalen modellen uit metadata database:', err.message);
        // Strikte foutafhandeling: gooi de fout door zodat Cube Core NIET stilzwijgend
        // een leeg schema compileert en alle actieve modellen in het geheugen wist!
        throw new Error(`[VAS Repository Error] Metadata database is niet beschikbaar: ${err.message}`);
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
      console.error('[schemaVersion] CRITICAL: Fout bij lezen schema_version_tracker:', err.message);
      // Gooi fout door bij database-uitval zodat Cube niet onbedoeld herlaadt naar een fallback
      throw new Error(`[VAS SchemaVersion Error] Kan schemaversie niet bepalen door metadata-database storing: ${err.message}`);
    }
  },

  // 1a. REST-API & GraphQL Authentication Hook (port 4000)
  // Decodeert en valideert JWT tokens of weigert toegang in productie (deny-by-default)
  checkAuth: async (req, auth) => {
    const token = auth || (req.headers && (req.headers.authorization || req.headers.Authorization));
    const rawToken = token ? token.replace(/^Bearer\s+/i, '') : null;
    const apiSecret = process.env.CUBEJS_API_SECRET || 'mysecretkey123';

    if (rawToken) {
      try {
        const decoded = jwt.verify(rawToken, apiSecret);
        const userObj = decoded.u || decoded.user || decoded;

        const role = userObj.role || userObj.role_id || (userObj.isAdmin ? 'admin' : 'viewer');
        const claims = userObj.claims || {};
        const isAdmin = Boolean(userObj.isAdmin || role === 'admin');

        req.securityContext = {
          username: userObj.username || 'api_user',
          name: userObj.name || userObj.display_name || userObj.username || 'API User',
          role,
          isAdmin,
          claims,
        };
        return;
      } catch (err) {
        console.warn('[checkAuth] JWT verificatie mislukt:', err.message);
        throw new Error(`[Authentication Failed] Ongeldig of verstreken token: ${err.message}`);
      }
    }

    // Deny-by-default in productie of wanneer dev mode expliciet uit staat
    if (process.env.NODE_ENV === 'production' || process.env.CUBEJS_DEV_MODE === 'false') {
      throw new Error('[Authentication Failed] Geen authenticatietoken meegegeven');
    }

    // Default context in ontwikkelmodus als er geen Bearer token is meegegeven
    req.securityContext = {
      username: 'dev_user',
      name: 'Developer',
      role: 'admin',
      isAdmin: true,
      claims: { region: 'global' },
    };
  },

  // Cache-isolatie per beveiligingscontext zodat RLS queries niet cross-contamineren in pre-aggregaties
  contextToAppId: ({ securityContext }) => {
    if (!securityContext) return 'CUBE_APP_ANON';
    const role = securityContext.role || 'viewer';
    const claimsKey = Object.entries(securityContext.claims || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(';');
    return `CUBE_APP_${role}_${claimsKey || 'default'}`;
  },

  // 1b. SQL-API Authentication Hook (PostgreSQL-wire protocol / Apache Superset / BI tools)
  // Dynamisch gevoed vanuit de centrale PostgreSQL database (user_accounts + security_roles)
  checkSqlAuth: async (req, user, password) => {
    console.log(`[checkSqlAuth] Authenticating SQL user: '${user}'`);

    try {
      const res = await pool.query(`
        SELECT u.*, r.is_admin, r.can_manage_models, r.can_manage_datasources
        FROM user_accounts u
        JOIN security_roles r ON u.role_id = r.name
        WHERE u.username = $1 AND u.is_active = true
      `, [user]);

      if (res.rows.length === 0) {
        console.warn(`[checkSqlAuth] User '${user}' niet gevonden of inactief`);
        throw new Error(`[Authentication Failed] Ongeldige inloggegevens voor SQL user: '${user}'`);
      }

      const userRow = res.rows[0];
      const isValid = verifyPassword(password, userRow.password_hash);
      if (!isValid) {
        console.warn(`[checkSqlAuth] Ongeldig wachtwoord voor user '${user}'`);
        throw new Error(`[Authentication Failed] Ongeldige inloggegevens voor SQL user: '${user}'`);
      }

      console.log(`[checkSqlAuth] Succesvol geauthenticeerd: '${user}' (rol: ${userRow.role_id}, admin: ${userRow.is_admin})`);
      return {
        password,
        superuser: userRow.is_admin || false,
        securityContext: {
          username: userRow.username,
          name: userRow.display_name,
          role: userRow.role_id,
          isAdmin: userRow.is_admin || false,
          claims: userRow.claims || {},
        }
      };
    } catch (err) {
      console.error(`[checkSqlAuth] Auth fout voor '${user}':`, err.message);
      throw err;
    }
  },

  // 2. QueryRewrite Hook: Dynamische configuratie-gestuurde RLS & OLS handhaving
  // Werkt voor SQL-API (15432) én REST-API (4000)
  queryRewrite: async (query, { securityContext }) => {
    // Admin / superuser heeft altijd volledige ongefilterde toegang
    if (!securityContext || securityContext.role === 'admin' || securityContext.isAdmin || securityContext.superuser) {
      return query;
    }

    const userRole = securityContext.role;
    const username = securityContext.username || 'anonymous';
    const userClaims = securityContext.claims || {};

    console.log(`[queryRewrite] Actieve beveiligingspolicy voor user: '${username}', rol: '${userRole}'`);

    // Dynamisch policies ophalen uit PostgreSQL voor de actieve rol
    let policies = [];
    try {
      const res = await pool.query(
        'SELECT * FROM access_policies WHERE role_id = $1 AND is_active = true ORDER BY cube_name ASC',
        [userRole]
      );
      policies = res.rows;
    } catch (err) {
      console.error(`[queryRewrite] Fout bij ophalen policies voor rol '${userRole}':`, err.message);
      // Deny-by-default: als we policies niet kunnen verifiëren, weigeren we toegang
      throw new Error(`[Security Error] Kan beveiligingsbeleid voor rol '${userRole}' niet verifiëren.`);
    }

    // Identificeer welke cubes en velden in de query worden geraakt
    const requestedMeasures = query.measures || [];
    const requestedDimensions = query.dimensions || [];
    const requestedSegments = query.segments || [];
    const filterMembers = (query.filters || []).map(f => f.member || '');
    const timeDimensionMembers = (query.timeDimensions || []).map(td => td.dimension || '');

    const allQueryMembers = [
      ...requestedMeasures,
      ...requestedDimensions,
      ...requestedSegments,
      ...filterMembers,
      ...timeDimensionMembers,
    ];

    const touchedCubes = new Set(
      allQueryMembers.map(m => m.split('.')[0]).filter(Boolean)
    );

    // 1. OBJECT-LEVEL SECURITY (OLS) HANDHAVING:
    // Blokkeert maatstaven of dimensies op basis van rol
    for (const policy of policies) {
      if (policy.policy_type === 'OLS') {
        const def = policy.definition || {};
        const denyMeasures = def.denyMeasures || [];
        const denyDimensions = def.denyDimensions || [];

        // Controleer verboden maatstaven
        for (const denied of denyMeasures) {
          if (requestedMeasures.includes(denied)) {
            throw new Error(
              `[Access Denied] Maatstaf '${denied}' is afgeschermd (Object-Level Security) en niet toegankelijk voor rol '${userRole}'.`
            );
          }
        }

        // Controleer verboden dimensies
        for (const denied of denyDimensions) {
          if (requestedDimensions.includes(denied)) {
            throw new Error(
              `[Access Denied] Dimensie '${denied}' is afgeschermd (Object-Level Security) en niet toegankelijk voor rol '${userRole}'.`
            );
          }
        }
      }
    }

    // 2. ROW-LEVEL SECURITY (RLS) HANDHAVING:
    // Past dynamisch rijfilters toe op basis van claims of vaste waarden
    for (const policy of policies) {
      if (policy.policy_type === 'RLS') {
        const targetCube = policy.cube_name;
        // Geldt voor alle cubes ('*') of wanneer de specifieke cube in de query voorkomt
        if (targetCube === '*' || touchedCubes.has(targetCube)) {
          const def = policy.definition || {};
          const member = def.member;
          const operator = def.operator || 'equals';

          if (!member) continue;

          // A. Claim-gebaseerde RLS: bijv. claimField: "city"
          if (def.claimField) {
            const claimVal = userClaims[def.claimField];
            // Deny-by-default: als de vereiste claim ontbreekt, weiger direct toegang
            if (claimVal === undefined || claimVal === null || claimVal === '') {
              throw new Error(
                `[Access Denied] Toegang geweigerd: vereiste beveiligingsclaim '${def.claimField}' ontbreekt voor gebruiker '${username}'.`
              );
            }

            query.filters = query.filters || [];
            const values = Array.isArray(claimVal) ? claimVal.map(String) : [String(claimVal)];
            query.filters.push({
              member,
              operator,
              values,
            });
            console.log(`[queryRewrite] RLS claim filter geactiveerd: ${member} ${operator} [${values.join(', ')}]`);
          }
          // B. Fixed-value RLS: bijv. fixedValue: "Netherlands"
          else if (def.fixedValue !== undefined && def.fixedValue !== null) {
            query.filters = query.filters || [];
            const values = Array.isArray(def.fixedValue) ? def.fixedValue.map(String) : [String(def.fixedValue)];
            query.filters.push({
              member,
              operator,
              values,
            });
            console.log(`[queryRewrite] RLS fixed filter geactiveerd: ${member} ${operator} [${values.join(', ')}]`);
          }
        }
      }
    }

    return query;
  }
};
