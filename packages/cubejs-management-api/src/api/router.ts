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
  restoreModel,
  cleanupArchivedRevisions,
  logAudit,
  getSchemaVersion,
  getActiveSchemaFiles,
  batchUpsertModels,
  BatchModelItem,
} from '../repository/modelStore';
import { VersionConflictError } from '../types';
import { validateSchemaContent, validateBatchSchemas } from '../compiler/validator';
import {
  upsertDataSource,
  getDataSource,
  getSafeDataSource,
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
import {
  getUserByUsername,
  listUsers,
  upsertUser,
  deleteUser,
  listRoles,
  upsertRole,
  listPolicies,
  upsertPolicy,
  deletePolicy,
} from '../repository/securityStore';
import { verifyPassword } from '../security/password';

export function createManagementRouter(pool: Pool, options: { apiSecret?: string; gitService?: GitService } = {}): Router {
  // Production Secret Safety Check (Fase 3: Eis 83)
  // Voorkom dat de service in productie start met de bekende standaardsecret 'mysecretkey123'
  if (process.env.NODE_ENV === 'production') {
    const activeSecret = options.apiSecret || process.env.CUBEJS_API_SECRET;
    if (!activeSecret || activeSecret === 'mysecretkey123') {
      throw new Error(
        '[Security Configuration Error] Productie-omgeving gedetecteerd (NODE_ENV=production), maar er is geen veilige CUBEJS_API_SECRET ingesteld of het standaard wachtwoord "mysecretkey123" is nog actief. De service weigert te starten.'
      );
    }
  }

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
      const includeDeleted = req.query.includeDeleted === 'true';
      const models = await getAllModels(pool, { includeDeleted });
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
        git_commit_hash,
        source = 'rest_api',
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

      const actor = req.user?.username || req.user?.actor || 'system';
      const created = await createModel(pool, {
        name,
        model_type,
        file_name: effectiveFileName,
        description,
        content,
        content_format,
        change_summary,
        git_commit_hash,
        actor,
        source,
      });

      res.status(201).json({ model: created });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /models/:id - Update model content with Optimistic Concurrency Control
  router.put('/models/:id', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const {
        content,
        content_format = 'yaml',
        change_summary,
        description,
        expectedRevisionNumber,
        expectedRevisionId,
        expectedVersion,
        git_commit_hash,
        source = 'rest_api',
      } = req.body;

      if (!content) {
        res.status(400).json({ error: 'Field "content" is required' });
        return;
      }

      const actor = req.user?.username || req.user?.actor || 'system';
      const updated = await updateModel(pool, id, {
        content,
        content_format,
        change_summary,
        description,
        expectedRevisionNumber,
        expectedRevisionId,
        expectedVersion,
        git_commit_hash,
        actor,
        source,
      });

      res.json({ model: updated });
    } catch (err: any) {
      // Handle Optimistic Concurrency Conflict (HTTP 409)
      if (err instanceof VersionConflictError || err.name === 'VersionConflictError') {
        res.status(409).json({
          error: 'Versieconflict gedetecteerd',
          code: 'VERSION_CONFLICT',
          modelId: err.modelId,
          expectedRevision: err.expectedRevision,
          currentRevision: err.currentRevision,
          currentChangeSummary: err.currentChangeSummary,
          currentUpdatedBy: err.currentUpdatedBy,
          message: err.message,
        });
        return;
      }

      // Handle Validation Failure (HTTP 422)
      if (err.validationErrors) {
        res.status(422).json({
          error: 'Validation failed',
          message: err.message,
          validationErrors: err.validationErrors,
        });
        return;
      }

      if (err.message && err.message.includes('not found')) {
        res.status(404).json({ error: err.message });
        return;
      }

      res.status(500).json({ error: err.message });
    }
  });

  // POST /models/:id/rollback/:revisionNumber - Validated atomic rollback to older revision
  router.post('/models/:id/rollback/:revisionNumber', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id, revisionNumber } = req.params;
      const revNum = parseInt(revisionNumber, 10);
      if (isNaN(revNum)) {
        res.status(400).json({ error: 'Revision number must be an integer' });
        return;
      }

      const actor = req.user?.username || req.user?.actor || 'system';
      const source = (req.body && req.body.source) || 'rest_api';
      const rolledBack = await rollbackModel(pool, id, revNum, actor, source);
      res.json({ model: rolledBack });
    } catch (err: any) {
      if (err.validationErrors) {
        res.status(422).json({
          error: 'Rollback validation failed',
          message: err.message,
          validationErrors: err.validationErrors,
        });
        return;
      }
      res.status(500).json({ error: err.message });
    }
  });

  // POST /models/:id/restore - Restore soft-deleted model
  router.post('/models/:id/restore', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const actor = req.user?.username || req.user?.actor || 'system';
      const source = (req.body && req.body.source) || 'rest_api';
      const restored = await restoreModel(pool, id, actor, source);
      res.json({ success: true, model: restored });
    } catch (err: any) {
      if (err.validationErrors) {
        res.status(422).json({
          error: 'Restore validation failed',
          message: err.message,
          validationErrors: err.validationErrors,
        });
        return;
      }
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /models/:id - Soft-delete model
  router.delete('/models/:id', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id } = req.params;
      const actor = req.user?.username || req.user?.actor || 'system';
      const source = (req.body && req.body.source) || 'rest_api';
      await deleteModel(pool, id, actor, source);
      res.json({ success: true, message: `Model ${id} soft-deleted` });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /models/cleanup-revisions - Retention cleanup for archived revisions
  router.post('/models/cleanup-revisions', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { retentionDays = 90, keepMinRevisions = 5 } = req.body;
      const actor = req.user?.username || req.user?.actor || 'system';
      const result = await cleanupArchivedRevisions(pool, {
        retentionDays: parseInt(retentionDays, 10),
        keepMinRevisions: parseInt(keepMinRevisions, 10),
        actor,
      });
      res.json({ success: true, ...result });
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
      const dsIdentifier = (req.query.dataSource as string) || (req.body && req.body.dataSource);
      const connection = req.body && req.body.connection;

      let connConfig: any = null;

      if (dsIdentifier && dsIdentifier !== 'default') {
        const storedDs = await getDataSource(pool, dsIdentifier);
        if (storedDs) {
          connConfig = {
            host: storedDs.host,
            port: storedDs.port,
            user: storedDs.username,
            password: storedDs.password,
            database: storedDs.database_name,
            ssl: storedDs.ssl ? { rejectUnauthorized: false } : false,
          };
        }
      } else if (connection && (connection.host || connection.database)) {
        connConfig = {
          host: connection.host || process.env.CUBEJS_DB_HOST || 'localhost',
          port: connection.port || parseInt(process.env.CUBEJS_DB_PORT || '5432', 10),
          user: connection.user || process.env.CUBEJS_DB_USER || 'postgres',
          password: connection.password || process.env.CUBEJS_DB_PASS || 'postgres',
          database: connection.database || process.env.CUBEJS_DB_NAME || 'cubedb',
          ssl: connection.ssl ? { rejectUnauthorized: false } : false,
        };
      }

      if (connConfig) {
        const client = new Client({
          ...connConfig,
          connectionTimeoutMillis: 5000,
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

  // GET /datasources - List all registered external data sources (passwords redacted)
  router.get('/datasources', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const dataSources = await listDataSources(pool);
      res.json(dataSources);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /datasources - Create or update a data source
  router.post('/datasources', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name, db_type, host, port, database_name, username, password, schema_name, ssl } = req.body;
      if (!name || !host || !database_name || !username) {
        res.status(400).json({ error: 'Fields "name", "host", "database_name", and "username" are required.' });
        return;
      }

      const ds = await upsertDataSource(pool, {
        name,
        db_type,
        host,
        port: port ? parseInt(port, 10) : 5432,
        database_name,
        username,
        password,
        schema_name,
        ssl: !!ssl,
      });

      const safe = await getSafeDataSource(pool, ds.id);
      res.json({ success: true, dataSource: safe });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /datasources/:idOrName - Delete a registered data source
  router.delete('/datasources/:idOrName', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const deleted = await deleteDataSource(pool, req.params.idOrName);
      if (deleted) {
        res.json({ success: true, message: `Data source ${req.params.idOrName} deleted.` });
      } else {
        res.status(404).json({ error: `Data source ${req.params.idOrName} not found.` });
      }
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /datasources/:idOrName/test - Test connection using stored data source credentials
  router.post('/datasources/:idOrName/test', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const ds = await getDataSource(pool, req.params.idOrName);
      if (!ds) {
        res.status(404).json({ error: `Data source ${req.params.idOrName} not found.` });
        return;
      }

      const testResult = await testDatabaseConnection({
        host: ds.host,
        port: ds.port,
        database: ds.database_name,
        user: ds.username,
        password: ds.password,
        ssl: ds.ssl,
      });

      res.json(testResult);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /datasources/preview-import - Preview batch import, conflict detection & join checks before commit
  router.post('/datasources/preview-import', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { tables, options = {}, connection, dataSourceName, dataSource } = req.body;
      if (!tables || !Array.isArray(tables) || tables.length === 0) {
        res.status(400).json({ error: 'Array of "tables" is required' });
        return;
      }

      const effectiveDataSource = dataSource || (connection && connection.host ? (dataSourceName || connection.database || 'remote_postgres') : undefined);
      const cleanDsName = effectiveDataSource && effectiveDataSource !== 'default'
        ? effectiveDataSource.toLowerCase().replace(/[^a-z0-9_]/g, '_')
        : undefined;

      // 1. Fetch existing models to detect conflicts
      const existingActiveRes = await pool.query(`
        SELECT sm.id, sm.name, sm.file_name, mr.content
        FROM semantic_models sm
        JOIN model_revisions mr ON sm.id = mr.model_id
        WHERE sm.is_active = true AND mr.status = 'active'
      `);
      const existingFiles = existingActiveRes.rows.map(r => ({
        fileName: r.file_name,
        content: r.content,
        readOnly: false,
      }));
      const existingModelMap = new Map(existingActiveRes.rows.map(r => [r.name, r]));
      const existingCubeNames = new Set(existingActiveRes.rows.map(r => r.name));

      // 2. Generate preview for each table
      const previewItems: any[] = [];
      const newFilesForValidation: any[] = [];

      for (const table of tables) {
        const gen = generateCubeDef(table, tables, {
          ...options,
          existingCubeNames,
          dataSource: cleanDsName,
        });

        const isConflict = existingModelMap.has(gen.cubeName);
        const existingModel = existingModelMap.get(gen.cubeName);

        previewItems.push({
          cubeName: gen.cubeName,
          fileName: gen.fileName,
          table: `${table.schema}.${table.name}`,
          isConflict,
          existingModelId: existingModel?.id,
          skippedJoins: gen.skippedJoins || [],
          joinsCount: gen.parsed.cubes[0]?.joins?.length || 0,
          dimensionsCount: gen.parsed.cubes[0]?.dimensions?.length || 0,
          measuresCount: gen.parsed.cubes[0]?.measures?.length || 0,
          yaml: gen.yaml,
          dataSource: cleanDsName || 'default',
        });

        newFilesForValidation.push({
          fileName: gen.fileName,
          content: gen.yaml,
        });
      }

      // 3. Pre-validate against compiler
      const validation = await validateBatchSchemas(newFilesForValidation, existingFiles);

      res.json({
        success: true,
        valid: validation.valid,
        validationErrors: validation.valid ? [] : validation.errors,
        warnings: validation.warnings || [],
        summary: {
          total: previewItems.length,
          toCreate: previewItems.filter(p => !p.isConflict).length,
          toUpdate: previewItems.filter(p => p.isConflict).length,
          totalSkippedJoins: previewItems.reduce((acc, p) => acc + (p.skippedJoins?.length || 0), 0),
        },
        items: previewItems,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /datasources/generate-cubes - Batch generate cubes from selected tables with FK joins, measures, and data sources
  router.post('/datasources/generate-cubes', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { tables, options = {}, connection, dataSourceName, dataSource } = req.body;
      if (!tables || !Array.isArray(tables) || tables.length === 0) {
        res.status(400).json({ error: 'Array of "tables" is required' });
        return;
      }

      const actor = req.user?.actor || 'VAS Data Source Explorer';

      // 1. Handle external data source registration or lookup
      let targetDataSource: string | undefined = undefined;
      if (dataSource && dataSource !== 'default') {
        targetDataSource = dataSource.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      } else if (connection && connection.host) {
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

  // GET /audit-logs - View audit trail with filtering
  router.get('/audit-logs', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const limit = parseInt((req.query.limit as string) || '100', 10);
      const conditions: string[] = [];
      const params: any[] = [];

      if (req.query.model_name) {
        params.push(req.query.model_name);
        conditions.push(`model_name = $${params.length}`);
      }
      if (req.query.action) {
        params.push(req.query.action);
        conditions.push(`action = $${params.length}`);
      }
      if (req.query.actor) {
        params.push(req.query.actor);
        conditions.push(`actor = $${params.length}`);
      }
      if (req.query.source) {
        params.push(req.query.source);
        conditions.push(`source = $${params.length}`);
      }
      if (req.query.result) {
        params.push(req.query.result);
        conditions.push(`result = $${params.length}`);
      }

      params.push(limit);
      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const query = `
        SELECT * FROM audit_logs 
        ${whereClause}
        ORDER BY created_at DESC 
        LIMIT $${params.length}
      `;
      const result = await pool.query(query, params);
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
  // Dynamische Identiteit, Rollen & RLS/OLS Beleid
  // ==========================================

  // GET /security/users - List active user accounts (passwords redacted)
  router.get('/security/users', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const users = await listUsers(pool);
      res.json({ users });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /security/users - Create or update user account
  router.post('/security/users', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { username, password, display_name, email, role_id, claims, is_active } = req.body;
      if (!username || !display_name || !role_id) {
        res.status(400).json({ error: 'Fields "username", "display_name", and "role_id" are required' });
        return;
      }
      const user = await upsertUser(pool, {
        username,
        password,
        display_name,
        email,
        role_id,
        claims: claims || {},
        is_active,
      });
      res.json({ success: true, user });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /security/users/:id - Soft-delete user account
  router.delete('/security/users/:id', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const success = await deleteUser(pool, req.params.id);
      if (!success) {
        res.status(404).json({ error: `User ${req.params.id} not found` });
        return;
      }
      res.json({ success: true, id: req.params.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /security/roles - List configured RBAC roles and policies from database
  router.get('/security/roles', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roles = await listRoles(pool);
      res.json({
        sqlApiEndpoint: {
          host: 'localhost',
          port: parseInt(process.env.CUBEJS_PG_SQL_PORT || '15432', 10),
          database: process.env.CUBEJS_DB_NAME || 'cubedb',
          protocol: 'PostgreSQL Wire Protocol v3 (Superset, PowerBI, Tableau, psql)'
        },
        roles,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /security/roles - Create or update role definition
  router.post('/security/roles', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { name, display_name, description, is_admin, can_manage_models, can_manage_datasources } = req.body;
      if (!name || !display_name) {
        res.status(400).json({ error: 'Fields "name" and "display_name" are required' });
        return;
      }
      const role = await upsertRole(pool, {
        name,
        display_name,
        description,
        is_admin,
        can_manage_models,
        can_manage_datasources,
      });
      res.json({ success: true, role });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /security/policies - List active RLS and OLS policies
  router.get('/security/policies', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const roleId = req.query.roleId as string | undefined;
      const policies = await listPolicies(pool, roleId);
      res.json({ policies });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /security/policies - Create or update policy
  router.post('/security/policies', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { id, role_id, cube_name, policy_type, definition } = req.body;
      if (!role_id || !cube_name || !policy_type || !definition) {
        res.status(400).json({ error: 'Fields "role_id", "cube_name", "policy_type", and "definition" are required' });
        return;
      }
      if (policy_type !== 'RLS' && policy_type !== 'OLS') {
        res.status(400).json({ error: 'Field "policy_type" must be either "RLS" or "OLS"' });
        return;
      }
      const policy = await upsertPolicy(pool, {
        id,
        role_id,
        cube_name,
        policy_type,
        definition,
      });
      res.json({ success: true, policy });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /security/policies/:id - Delete policy
  router.delete('/security/policies/:id', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const success = await deletePolicy(pool, req.params.id);
      if (!success) {
        res.status(404).json({ error: `Policy ${req.params.id} not found` });
        return;
      }
      res.json({ success: true, id: req.params.id });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /security/test-sql - Execute SQL query against Cube SQL API as a specific role
  // Veiligheidsmaatregelen: server-side authenticatie, LIMIT 100 afgedwongen, credentials geredigeerd
  router.post('/security/test-sql', async (req: AuthenticatedRequest, res: Response) => {
    // In productie: vereist expliciete admin-rechten
    if (process.env.NODE_ENV === 'production' && !req.user?.isAdmin) {
      res.status(403).json({ error: 'SQL Testing endpoint is uitgeschakeld in productie zonder expliciete beheerrechten' });
      return;
    }

    const { username, password, sql } = req.body;
    if (!username || !password || !sql) {
      res.status(400).json({ error: 'Fields "username", "password" and "sql" are required' });
      return;
    }

    // 1. Verifieer de gebruiker tegen de centrale user_accounts tabel
    const user = await getUserByUsername(pool, username);
    if (!user) {
      res.status(401).json({ success: false, user: username, error: `Gebruiker '${username}' bestaat niet of is inactief.` });
      return;
    }

    if (!user.password_hash || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ success: false, user: username, error: `Ongeldig wachtwoord voor gebruiker '${username}'.` });
      return;
    }

    // 2. Beperk query met automatische LIMIT 100 voor veiligheid
    let sanitizedSql = sql.trim().replace(/;+$/, '');
    if (!/\blimit\s+\d+/i.test(sanitizedSql)) {
      sanitizedSql += ' LIMIT 100';
    }

    const pgPort = parseInt(process.env.CUBEJS_PG_SQL_PORT || '15432', 10);
    // In Docker draait Cube binnen dezelfde container of op localhost
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
      const result = await client.query(sanitizedSql);
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
      // Redigeer wachtwoorden en gevoelige strings uit foutmeldingen
      const sanitizedMsg = (err.message || '')
        .replace(/password=\S+/gi, 'password=***')
        .replace(/:\/\/[^@]+@/, '://***@');
      res.status(400).json({
        success: false,
        user: username,
        error: sanitizedMsg
      });
    } finally {
      await client.end().catch(() => {});
    }
  });

  return router;
}
