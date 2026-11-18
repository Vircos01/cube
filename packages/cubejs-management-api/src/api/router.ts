import express, { Router, Response } from 'express';
import path from 'path';
import { Pool, Client } from 'pg';
import {
  getAllModels,
  getModelById,
  createModel,
  updateModel,
  rollbackModel,
  deleteModel,
  getSchemaVersion,
  getActiveSchemaFiles,
  batchUpsertModels,
  BatchModelItem,
} from '../repository/modelStore';
import { validateSchemaContent, validateBatchSchemas } from '../compiler/validator';
import {
  upsertDataSource,
  getDataSource,
  listDataSources,
  deleteDataSource,
} from '../repository/dataSourceStore';
import {
  introspectPostgresDatabase,
  testDatabaseConnection,
  generateCubeDef,
  toCubeName
} from './introspect';
import { createAuthMiddleware, AuthenticatedRequest } from './auth';
import { importModelsFromDirectory, exportModelsToDirectory } from '../repository/fileMigrator';
import { GitService } from '../git/gitService';

export function createManagementRouter(pool: Pool, options: { apiSecret?: string; gitService?: GitService } = {}): Router {
  const router = Router();
  const auth = createAuthMiddleware(options.apiSecret);
  const git = options.gitService || new GitService();

  // Web-UI static dashboard on /admin
  const publicDir = path.resolve(__dirname, '../../public');
  router.use('/admin', express.static(publicDir));
  router.get('/admin*', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
  });

  // Health check
  router.get('/health', async (req, res) => {
    try {
      const version = await getSchemaVersion(pool);
      res.json({ status: 'ok', schemaVersion: version });
    } catch (err: any) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  // Apply authentication to all following endpoints
  router.use(auth);

  // GET /models - List all models with their active revision
  router.get('/models', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const models = await getAllModels(pool);
      res.json({ models });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /models/:id - Get details of a single model and its revisions
  router.get('/models/:id', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const model = await getModelById(pool, req.params.id);
      if (!model) {
        res.status(404).json({ error: `Model ${req.params.id} not found` });
        return;
      }
      res.json({ model });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /models/validate - In-memory validation without saving
  router.post('/models/validate', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { content, fileName = 'model.cube.yml', dialect = 'postgres' } = req.body;
      if (!content) {
        res.status(400).json({ error: 'Field "content" is required for validation' });
        return;
      }

      const existingFiles = await getActiveSchemaFiles(pool);
      const result = await validateSchemaContent(content, fileName, existingFiles, dialect);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ valid: false, errors: [{ message: err.message, code: 'VALIDATION_EXCEPTION' }] });
    }
  });

  // POST /models - Create a new semantic model and revision 1
  router.post('/models', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const {
        name,
        model_type = 'cube',
        file_name,
        description,
        content,
        content_format = 'yaml',
        change_summary,
        skip_validation = false,
      } = req.body;

      if (!name || !content) {
        res.status(400).json({ error: 'Fields "name" and "content" are required' });
        return;
      }

      const effectiveFileName = file_name || `${name}.${model_type}.yml`;

      // Validate schema unless explicitly skipped
      if (!skip_validation) {
        const existingFiles = await getActiveSchemaFiles(pool);
        const validation = await validateSchemaContent(content, effectiveFileName, existingFiles);
        if (!validation.valid) {
          res.status(422).json({
            error: 'Validation failed',
            validation,
          });
          return;
        }
      }

      const actor = req.user?.actor || 'system';
      const created = await createModel(pool, {
        name,
        model_type,
        file_name: effectiveFileName,
        description,
        content,
        content_format,
        change_summary,
        actor,
      });

      res.status(201).json({ model: created });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /models/:id - Update model content (creates a new revision and bumps version)
  router.put('/models/:id', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const { content, content_format = 'yaml', change_summary, description, skip_validation = false } = req.body;

      if (!content) {
        res.status(400).json({ error: 'Field "content" is required' });
        return;
      }

      const existing = await getModelById(pool, id);
      if (!existing) {
        res.status(404).json({ error: `Model ${id} not found` });
        return;
      }

      if (!skip_validation) {
        const existingFiles = await getActiveSchemaFiles(pool);
        const validation = await validateSchemaContent(content, existing.file_name, existingFiles);
        if (!validation.valid) {
          res.status(422).json({
            error: 'Validation failed',
            validation,
          });
          return;
        }
      }

      const actor = req.user?.actor || 'system';
      const updated = await updateModel(pool, id, {
        content,
        content_format,
        change_summary,
        description,
        actor,
      });

      res.json({ model: updated });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /models/:id/rollback/:revisionNumber - Rollback to older revision
  router.post('/models/:id/rollback/:revisionNumber', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id, revisionNumber } = req.params;
      const revNum = parseInt(revisionNumber, 10);
      if (isNaN(revNum)) {
        res.status(400).json({ error: 'Revision number must be an integer' });
        return;
      }

      const actor = req.user?.actor || 'system';
      const rolledBack = await rollbackModel(pool, id, revNum, actor);
      res.json({ model: rolledBack });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /models/:id - Deactivate model
  router.delete('/models/:id', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const actor = req.user?.actor || 'system';
      await deleteModel(pool, id, actor);
      res.json({ success: true, message: `Model ${id} deactivated` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /datasources/test-connection - Test source database connection
  router.post('/datasources/test-connection', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const config = req.body || {};
      const result = await testDatabaseConnection(config);
      if (result.success) {
        res.json(result);
      } else {
        res.status(400).json(result);
      }
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET & POST /datasources/introspect - Inspect database tables, columns & foreign keys
  const handleIntrospect = async (req: AuthenticatedRequest, res: Response) => {
    try {
      const schema = (req.query.schema as string) || (req.body && req.body.schema) || 'public';
      const connection = req.body && req.body.connection;

      if (connection && (connection.host || connection.database)) {
        // Use custom connection
        const client = new Client({
          host: connection.host || process.env.CUBEJS_DB_HOST || 'localhost',
          port: connection.port || parseInt(process.env.CUBEJS_DB_PORT || '5432', 10),
          user: connection.user || process.env.CUBEJS_DB_USER || 'postgres',
          password: connection.password || process.env.CUBEJS_DB_PASS || 'postgres',
          database: connection.database || process.env.CUBEJS_DB_NAME || 'cubedb',
          ssl: connection.ssl ? { rejectUnauthorized: false } : false,
          connectionTimeoutMillis: 5000
        });

        try {
          await client.connect();
          const result = await introspectPostgresDatabase(client, schema);
          res.json(result);
        } finally {
          await client.end().catch(() => {});
        }
      } else {
        // Use default pool
        const result = await introspectPostgresDatabase(pool, schema);
        res.json(result);
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  };

  router.get('/datasources/introspect', handleIntrospect);
  router.post('/datasources/introspect', handleIntrospect);

  // GET /datasources - List all registered external data sources
  router.get('/datasources', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const dataSources = await listDataSources(pool);
      res.json(dataSources);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /datasources/generate-cubes - Batch generate cubes from selected tables with FK joins, measures, and data sources
  router.post('/datasources/generate-cubes', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { tables, options = {}, connection, dataSourceName } = req.body;
      if (!tables || !Array.isArray(tables) || tables.length === 0) {
        res.status(400).json({ error: 'Array of "tables" is required' });
        return;
      }

      const actor = req.user?.actor || 'VAS Data Source Explorer';

      // 1. Handle external data source registration if connection configuration is provided
      let targetDataSource: string | undefined = undefined;
      if (connection && connection.host) {
        // Derive clean data source identifier
        const rawDsName = (dataSourceName || connection.dataSourceName || connection.database || 'remote_postgres');
        const dsName = rawDsName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        targetDataSource = dsName;

        // Upsert into data_sources table so Cube runtime driverFactory can resolve it
        await upsertDataSource(pool, {
          name: dsName,
          db_type: connection.type || 'postgres',
          host: connection.host,
          port: connection.port || 5432,
          database_name: connection.database || connection.database_name || 'postgres',
          username: connection.user || connection.username || 'postgres',
          password: connection.password || '',
          schema_name: connection.schema || 'public',
          ssl: !!connection.ssl,
        });
      }

      // 2. Fetch all existing active models to check join targets and for validation
      const existingActiveRes = await pool.query(`
        SELECT sm.name, sm.file_name, mr.content
        FROM semantic_models sm
        JOIN model_revisions mr ON sm.id = mr.model_id
        WHERE sm.is_active = true AND mr.status = 'active'
      `);
      const existingFiles = existingActiveRes.rows.map(r => ({
        fileName: r.file_name,
        content: r.content,
        readOnly: false,
      }));
      const existingCubeNames = new Set(existingActiveRes.rows.map(r => r.name));

      // 3. Generate Cube definitions safely (only generating joins to available cubes)
      const generatedItems: Array<{
        table: any;
        gen: ReturnType<typeof generateCubeDef>;
      }> = [];

      for (const table of tables) {
        const gen = generateCubeDef(table, tables, {
          ...options,
          existingCubeNames,
          dataSource: targetDataSource,
        });
        generatedItems.push({ table, gen });
      }

      // 4. Pre-validate the entire batch together with existing models
      const newFilesForValidation = generatedItems.map(g => ({
        fileName: g.gen.fileName,
        content: g.gen.yaml,
      }));

      const batchValidation = await validateBatchSchemas(newFilesForValidation, existingFiles);
      if (!batchValidation.valid) {
        res.status(400).json({
          error: 'Batch schema validation failed',
          validationErrors: batchValidation.errors,
          warnings: batchValidation.warnings,
        });
        return;
      }

      // 5. Atomic Batch Upsert in a single transaction with ONE schemaVersion bump
      const batchItems: BatchModelItem[] = generatedItems.map(({ table, gen }) => ({
        name: gen.cubeName,
        file_name: gen.fileName,
        model_type: 'cube',
        content: gen.yaml,
        description: `Generated from table ${table.schema}.${table.name}${targetDataSource ? ` (Data source: ${targetDataSource})` : ''}`,
        change_summary: `Imported from database table ${table.schema}.${table.name}${targetDataSource ? ` via ${targetDataSource}` : ''}`,
      }));

      const upserted = await batchUpsertModels(pool, batchItems, actor);

      const results = upserted.map((u, i) => ({
        model: u.model,
        revision: u.revision,
        cubeName: generatedItems[i].gen.cubeName,
        fileName: generatedItems[i].gen.fileName,
        table: `${generatedItems[i].table.schema}.${generatedItems[i].table.name}`,
        isUpdate: u.isUpdate,
        skippedJoins: generatedItems[i].gen.skippedJoins,
        dataSource: targetDataSource || 'default',
      }));

      res.json({
        success: true,
        count: results.length,
        dataSource: targetDataSource || 'default',
        imported: results,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /models/import - Import models from directory
  router.post('/models/import', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { directoryPath = path.resolve(process.cwd(), 'model') } = req.body;
      const actor = req.user?.actor || 'system';
      const result = await importModelsFromDirectory(pool, directoryPath, actor);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /models/export - Export models to directory
  router.post('/models/export', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { targetDirectory = path.resolve(process.cwd(), 'model') } = req.body;
      const result = await exportModelsToDirectory(pool, targetDirectory);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /audit-logs - View audit trail
  router.get('/audit-logs', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const limit = parseInt((req.query.limit as string) || '50', 10);
      const query = `
        SELECT * FROM audit_logs 
        ORDER BY created_at DESC 
        LIMIT $1
      `;
      const result = await pool.query(query, [limit]);
      res.json({ auditLogs: result.rows });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- GIT INTEGRATION ENDPOINTS ---

  // GET /git/status
  router.get('/git/status', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const isAvailable = await git.isGitAvailable();
      if (!isAvailable) {
        res.json({ available: false, error: 'Git repository not found or not initialized' });
        return;
      }
      const status = await git.getStatus(pool);
      res.json({ available: true, ...status });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /git/diff
  router.get('/git/diff', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const staged = req.query.staged === 'true';
      const result = await git.getDiff(staged);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /git/log
  router.get('/git/log', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const limit = parseInt((req.query.limit as string) || '20', 10);
      const log = await git.getLog(limit);
      res.json({ commits: log });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /git/branches
  router.get('/git/branches', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await git.listBranches();
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /git/commit
  router.post('/git/commit', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { message, push = false } = req.body;
      if (!message) {
        res.status(400).json({ error: 'Field "message" is required for git commit' });
        return;
      }
      const author = req.user?.actor || 'Cube Web-UI';
      const result = await git.commitChanges(pool, { message, author, push });
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /git/pull
  router.post('/git/pull', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { remote = 'origin', branch } = req.body;
      const result = await git.pullChanges(pool, { remote, branch });
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /git/checkout
  router.post('/git/checkout', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { branch, createNew = false } = req.body;
      if (!branch) {
        res.status(400).json({ error: 'Field "branch" is required' });
        return;
      }
      const result = await git.checkoutBranch(branch, createNew, pool);
      res.json({ success: true, ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================
  // SECURITY & ACCESS CONTROL (SSAS / RBAC)
  // ==========================================

  // GET /security/roles - List configured RBAC roles and policies
  router.get('/security/roles', async (req, res) => {
    res.json({
      sqlApiEndpoint: {
        host: 'localhost',
        port: parseInt(process.env.CUBEJS_PG_SQL_PORT || '15432', 10),
        database: process.env.CUBEJS_DB_NAME || 'cubedb',
        protocol: 'PostgreSQL Wire Protocol v3 (Superset, PowerBI, Tableau, psql)'
      },
      roles: [
        {
          username: 'admin',
          password: 'admin',
          name: 'Global Administrator',
          role: 'admin',
          description: 'Volledige ongefilterde toegang tot alle data, alle rijen en alle maatstaven.',
          rlsPolicy: 'Geen beperkingen (ziet alle orders en gebruikers wereldwijd)',
          olsPolicy: 'Alle maatstaven toegestaan (count, total_amount, avg_order_value)',
          expectedRows: 7
        },
        {
          username: 'sales_amsterdam',
          password: 'amsterdam123',
          name: 'Sales Rep Amsterdam',
          role: 'sales_rep',
          description: 'Toegewezen aan regio Amsterdam. Automatische dynamische Row-Level Security.',
          rlsPolicy: 'Users.city = "Amsterdam" (ziet uitsluitend orders 1 & 2 van Amsterdamse klanten)',
          olsPolicy: 'Maatstaf "Orders.avg_order_value" afgeschermd (Access Denied bij opvragen)',
          expectedRows: 2
        },
        {
          username: 'sales_rotterdam',
          password: 'rotterdam123',
          name: 'Sales Rep Rotterdam',
          role: 'sales_rep',
          description: 'Toegewezen aan regio Rotterdam. Automatische dynamische Row-Level Security.',
          rlsPolicy: 'Users.city = "Rotterdam" (ziet uitsluitend orders 3 & 6 van Rotterdamse klanten)',
          olsPolicy: 'Standaard sales maatstaven (count, total_amount) toegestaan',
          expectedRows: 2
        }
      ]
    });
  });

  // POST /security/test-sql - Execute SQL query against Cube SQL API as a specific role
  router.post('/security/test-sql', async (req, res) => {
    const { username, password, sql } = req.body;
    if (!username || !password || !sql) {
      res.status(400).json({ error: 'Fields "username", "password" and "sql" are required' });
      return;
    }

    const pgPort = parseInt(process.env.CUBEJS_PG_SQL_PORT || '15432', 10);
    // In Docker, cube runs inside the same container or host
    const client = new Client({
      host: '127.0.0.1',
      port: pgPort,
      user: username,
      password: password,
      database: process.env.CUBEJS_DB_NAME || 'cubedb',
      connectionTimeoutMillis: 4000
    });

    try {
      await client.connect();
      const startTime = Date.now();
      const result = await client.query(sql);
      const durationMs = Date.now() - startTime;

      res.json({
        success: true,
        user: username,
        durationMs,
        rowCount: result.rows.length,
        rows: result.rows,
        fields: (result.fields || []).map((f: any) => f.name)
      });
    } catch (err: any) {
      res.status(400).json({
        success: false,
        user: username,
        error: err.message
      });
    } finally {
      await client.end().catch(() => {});
    }
  });

  return router;
}
