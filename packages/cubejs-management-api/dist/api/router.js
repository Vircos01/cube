"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createManagementRouter = createManagementRouter;
const express_1 = __importStar(require("express"));
const path_1 = __importDefault(require("path"));
const pg_1 = require("pg");
const modelStore_1 = require("../repository/modelStore");
const types_1 = require("../types");
const validator_1 = require("../compiler/validator");
const dataSourceStore_1 = require("../repository/dataSourceStore");
const introspect_1 = require("./introspect");
const auth_1 = require("./auth");
const fileMigrator_1 = require("../repository/fileMigrator");
const gitService_1 = require("../git/gitService");
const securityStore_1 = require("../repository/securityStore");
const password_1 = require("../security/password");
function createManagementRouter(pool, options = {}) {
    // Production Secret Safety Check (Fase 3: Eis 83)
    // Voorkom dat de service in productie start met de bekende standaardsecret 'mysecretkey123'
    if (process.env.NODE_ENV === 'production') {
        const activeSecret = options.apiSecret || process.env.CUBEJS_API_SECRET;
        if (!activeSecret || activeSecret === 'mysecretkey123') {
            throw new Error('[Security Configuration Error] Productie-omgeving gedetecteerd (NODE_ENV=production), maar er is geen veilige CUBEJS_API_SECRET ingesteld of het standaard wachtwoord "mysecretkey123" is nog actief. De service weigert te starten.');
        }
    }
    const router = (0, express_1.Router)();
    const auth = (0, auth_1.createAuthMiddleware)(options.apiSecret);
    const git = options.gitService || new gitService_1.GitService();
    // Web-UI static dashboard on /admin
    const publicDir = path_1.default.resolve(__dirname, '../../public');
    router.use('/admin', express_1.default.static(publicDir));
    router.get('/admin*', (req, res) => {
        res.sendFile(path_1.default.join(publicDir, 'index.html'));
    });
    // Health check
    router.get('/health', async (req, res) => {
        try {
            const version = await (0, modelStore_1.getSchemaVersion)(pool);
            res.json({ status: 'ok', schemaVersion: version });
        }
        catch (err) {
            res.status(500).json({ status: 'error', error: err.message });
        }
    });
    // Apply authentication to all following endpoints
    router.use(auth);
    // GET /models - List all models with their active revision
    router.get('/models', async (req, res) => {
        try {
            const includeDeleted = req.query.includeDeleted === 'true';
            const models = await (0, modelStore_1.getAllModels)(pool, { includeDeleted });
            res.json({ models });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // GET /models/:id - Get details of a single model and its revisions
    router.get('/models/:id', async (req, res) => {
        try {
            const model = await (0, modelStore_1.getModelById)(pool, req.params.id);
            if (!model) {
                res.status(404).json({ error: `Model ${req.params.id} not found` });
                return;
            }
            res.json({ model });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /models/validate - In-memory validation without saving
    router.post('/models/validate', async (req, res) => {
        try {
            const { content, fileName = 'model.cube.yml', dialect = 'postgres' } = req.body;
            if (!content) {
                res.status(400).json({ error: 'Field "content" is required for validation' });
                return;
            }
            const existingFiles = await (0, modelStore_1.getActiveSchemaFiles)(pool);
            const result = await (0, validator_1.validateSchemaContent)(content, fileName, existingFiles, dialect);
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ valid: false, errors: [{ message: err.message, code: 'VALIDATION_EXCEPTION' }] });
        }
    });
    // POST /models - Create a new semantic model and revision 1
    router.post('/models', async (req, res) => {
        try {
            const { name, model_type = 'cube', file_name, description, content, content_format = 'yaml', change_summary, git_commit_hash, source = 'rest_api', skip_validation = false, } = req.body;
            if (!name || !content) {
                res.status(400).json({ error: 'Fields "name" and "content" are required' });
                return;
            }
            const effectiveFileName = file_name || `${name}.${model_type}.yml`;
            // Validate schema unless explicitly skipped
            if (!skip_validation) {
                const existingFiles = await (0, modelStore_1.getActiveSchemaFiles)(pool);
                const validation = await (0, validator_1.validateSchemaContent)(content, effectiveFileName, existingFiles);
                if (!validation.valid) {
                    res.status(422).json({
                        error: 'Validation failed',
                        validation,
                    });
                    return;
                }
            }
            const actor = req.user?.username || req.user?.actor || 'system';
            const created = await (0, modelStore_1.createModel)(pool, {
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
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // PUT /models/:id - Update model content with Optimistic Concurrency Control
    router.put('/models/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const { content, content_format = 'yaml', change_summary, description, expectedRevisionNumber, expectedRevisionId, expectedVersion, git_commit_hash, source = 'rest_api', } = req.body;
            if (!content) {
                res.status(400).json({ error: 'Field "content" is required' });
                return;
            }
            const actor = req.user?.username || req.user?.actor || 'system';
            const updated = await (0, modelStore_1.updateModel)(pool, id, {
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
        }
        catch (err) {
            // Handle Optimistic Concurrency Conflict (HTTP 409)
            if (err instanceof types_1.VersionConflictError || err.name === 'VersionConflictError') {
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
    router.post('/models/:id/rollback/:revisionNumber', async (req, res) => {
        try {
            const { id, revisionNumber } = req.params;
            const revNum = parseInt(revisionNumber, 10);
            if (isNaN(revNum)) {
                res.status(400).json({ error: 'Revision number must be an integer' });
                return;
            }
            const actor = req.user?.username || req.user?.actor || 'system';
            const source = (req.body && req.body.source) || 'rest_api';
            const rolledBack = await (0, modelStore_1.rollbackModel)(pool, id, revNum, actor, source);
            res.json({ model: rolledBack });
        }
        catch (err) {
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
    router.post('/models/:id/restore', async (req, res) => {
        try {
            const { id } = req.params;
            const actor = req.user?.username || req.user?.actor || 'system';
            const source = (req.body && req.body.source) || 'rest_api';
            const restored = await (0, modelStore_1.restoreModel)(pool, id, actor, source);
            res.json({ success: true, model: restored });
        }
        catch (err) {
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
    router.delete('/models/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const actor = req.user?.username || req.user?.actor || 'system';
            const source = (req.body && req.body.source) || 'rest_api';
            await (0, modelStore_1.deleteModel)(pool, id, actor, source);
            res.json({ success: true, message: `Model ${id} soft-deleted` });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /models/cleanup-revisions - Retention cleanup for archived revisions
    router.post('/models/cleanup-revisions', async (req, res) => {
        try {
            const { retentionDays = 90, keepMinRevisions = 5 } = req.body;
            const actor = req.user?.username || req.user?.actor || 'system';
            const result = await (0, modelStore_1.cleanupArchivedRevisions)(pool, {
                retentionDays: parseInt(retentionDays, 10),
                keepMinRevisions: parseInt(keepMinRevisions, 10),
                actor,
            });
            res.json({ success: true, ...result });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /datasources/test-connection - Test source database connection
    router.post('/datasources/test-connection', async (req, res) => {
        try {
            const config = req.body || {};
            const result = await (0, introspect_1.testDatabaseConnection)(config);
            if (result.success) {
                res.json(result);
            }
            else {
                res.status(400).json(result);
            }
        }
        catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });
    // GET & POST /datasources/introspect - Inspect database tables, columns & foreign keys
    const handleIntrospect = async (req, res) => {
        try {
            const schema = req.query.schema || (req.body && req.body.schema) || 'public';
            const dsIdentifier = req.query.dataSource || (req.body && req.body.dataSource);
            const connection = req.body && req.body.connection;
            let connConfig = null;
            if (dsIdentifier && dsIdentifier !== 'default') {
                const storedDs = await (0, dataSourceStore_1.getDataSource)(pool, dsIdentifier);
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
            }
            else if (connection && (connection.host || connection.database)) {
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
                const client = new pg_1.Client({
                    ...connConfig,
                    connectionTimeoutMillis: 5000,
                });
                try {
                    await client.connect();
                    const result = await (0, introspect_1.introspectPostgresDatabase)(client, schema);
                    res.json(result);
                }
                finally {
                    await client.end().catch(() => { });
                }
            }
            else {
                // Use default pool
                const result = await (0, introspect_1.introspectPostgresDatabase)(pool, schema);
                res.json(result);
            }
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    };
    router.get('/datasources/introspect', handleIntrospect);
    router.post('/datasources/introspect', handleIntrospect);
    // GET /datasources - List all registered external data sources (passwords redacted)
    router.get('/datasources', async (req, res) => {
        try {
            const dataSources = await (0, dataSourceStore_1.listDataSources)(pool);
            res.json(dataSources);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /datasources - Create or update a data source
    router.post('/datasources', async (req, res) => {
        try {
            const { name, db_type, host, port, database_name, username, password, schema_name, ssl } = req.body;
            if (!name || !host || !database_name || !username) {
                res.status(400).json({ error: 'Fields "name", "host", "database_name", and "username" are required.' });
                return;
            }
            const ds = await (0, dataSourceStore_1.upsertDataSource)(pool, {
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
            const safe = await (0, dataSourceStore_1.getSafeDataSource)(pool, ds.id);
            res.json({ success: true, dataSource: safe });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // DELETE /datasources/:idOrName - Delete a registered data source
    router.delete('/datasources/:idOrName', async (req, res) => {
        try {
            const deleted = await (0, dataSourceStore_1.deleteDataSource)(pool, req.params.idOrName);
            if (deleted) {
                res.json({ success: true, message: `Data source ${req.params.idOrName} deleted.` });
            }
            else {
                res.status(404).json({ error: `Data source ${req.params.idOrName} not found.` });
            }
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /datasources/:idOrName/test - Test connection using stored data source credentials
    router.post('/datasources/:idOrName/test', async (req, res) => {
        try {
            const ds = await (0, dataSourceStore_1.getDataSource)(pool, req.params.idOrName);
            if (!ds) {
                res.status(404).json({ error: `Data source ${req.params.idOrName} not found.` });
                return;
            }
            const testResult = await (0, introspect_1.testDatabaseConnection)({
                host: ds.host,
                port: ds.port,
                database: ds.database_name,
                user: ds.username,
                password: ds.password,
                ssl: ds.ssl,
            });
            res.json(testResult);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /datasources/preview-import - Preview batch import, conflict detection & join checks before commit
    router.post('/datasources/preview-import', async (req, res) => {
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
            const previewItems = [];
            const newFilesForValidation = [];
            for (const table of tables) {
                const gen = (0, introspect_1.generateCubeDef)(table, tables, {
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
            const validation = await (0, validator_1.validateBatchSchemas)(newFilesForValidation, existingFiles);
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
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /datasources/generate-cubes - Batch generate cubes from selected tables with FK joins, measures, and data sources
    router.post('/datasources/generate-cubes', async (req, res) => {
        try {
            const { tables, options = {}, connection, dataSourceName, dataSource } = req.body;
            if (!tables || !Array.isArray(tables) || tables.length === 0) {
                res.status(400).json({ error: 'Array of "tables" is required' });
                return;
            }
            const actor = req.user?.actor || 'VAS Data Source Explorer';
            // 1. Handle external data source registration or lookup
            let targetDataSource = undefined;
            if (dataSource && dataSource !== 'default') {
                targetDataSource = dataSource.toLowerCase().replace(/[^a-z0-9_]/g, '_');
            }
            else if (connection && connection.host) {
                // Derive clean data source identifier
                const rawDsName = (dataSourceName || connection.dataSourceName || connection.database || 'remote_postgres');
                const dsName = rawDsName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
                targetDataSource = dsName;
                // Upsert into data_sources table so Cube runtime driverFactory can resolve it
                await (0, dataSourceStore_1.upsertDataSource)(pool, {
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
            const generatedItems = [];
            for (const table of tables) {
                const gen = (0, introspect_1.generateCubeDef)(table, tables, {
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
            const batchValidation = await (0, validator_1.validateBatchSchemas)(newFilesForValidation, existingFiles);
            if (!batchValidation.valid) {
                res.status(400).json({
                    error: 'Batch schema validation failed',
                    validationErrors: batchValidation.errors,
                    warnings: batchValidation.warnings,
                });
                return;
            }
            // 5. Atomic Batch Upsert in a single transaction with ONE schemaVersion bump
            const batchItems = generatedItems.map(({ table, gen }) => ({
                name: gen.cubeName,
                file_name: gen.fileName,
                model_type: 'cube',
                content: gen.yaml,
                description: `Generated from table ${table.schema}.${table.name}${targetDataSource ? ` (Data source: ${targetDataSource})` : ''}`,
                change_summary: `Imported from database table ${table.schema}.${table.name}${targetDataSource ? ` via ${targetDataSource}` : ''}`,
            }));
            const upserted = await (0, modelStore_1.batchUpsertModels)(pool, batchItems, actor);
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
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /models/import - Import models from directory
    router.post('/models/import', async (req, res) => {
        try {
            const { directoryPath = path_1.default.resolve(process.cwd(), 'model') } = req.body;
            const actor = req.user?.actor || 'system';
            const result = await (0, fileMigrator_1.importModelsFromDirectory)(pool, directoryPath, actor);
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /models/export - Export models to directory
    router.post('/models/export', async (req, res) => {
        try {
            const { targetDirectory = path_1.default.resolve(process.cwd(), 'model') } = req.body;
            const result = await (0, fileMigrator_1.exportModelsToDirectory)(pool, targetDirectory);
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // GET /audit-logs - View audit trail with filtering
    router.get('/audit-logs', async (req, res) => {
        try {
            const limit = parseInt(req.query.limit || '100', 10);
            const conditions = [];
            const params = [];
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
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // --- GIT INTEGRATION ENDPOINTS ---
    // GET /git/status
    router.get('/git/status', async (req, res) => {
        try {
            const isAvailable = await git.isGitAvailable();
            if (!isAvailable) {
                res.json({ available: false, error: 'Git repository not found or not initialized' });
                return;
            }
            const status = await git.getStatus(pool);
            res.json({ available: true, ...status });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // GET /git/diff
    router.get('/git/diff', async (req, res) => {
        try {
            const staged = req.query.staged === 'true';
            const result = await git.getDiff(staged);
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // GET /git/log
    router.get('/git/log', async (req, res) => {
        try {
            const limit = parseInt(req.query.limit || '20', 10);
            const log = await git.getLog(limit);
            res.json({ commits: log });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // GET /git/branches
    router.get('/git/branches', async (req, res) => {
        try {
            const result = await git.listBranches();
            res.json(result);
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /git/commit
    router.post('/git/commit', async (req, res) => {
        try {
            const { message, push = false } = req.body;
            if (!message) {
                res.status(400).json({ error: 'Field "message" is required for git commit' });
                return;
            }
            const author = req.user?.actor || 'Cube Web-UI';
            const result = await git.commitChanges(pool, { message, author, push });
            res.json({ success: true, ...result });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /git/pull
    router.post('/git/pull', async (req, res) => {
        try {
            const { remote = 'origin', branch } = req.body;
            const result = await git.pullChanges(pool, { remote, branch });
            res.json({ success: true, ...result });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /git/checkout
    router.post('/git/checkout', async (req, res) => {
        try {
            const { branch, createNew = false } = req.body;
            if (!branch) {
                res.status(400).json({ error: 'Field "branch" is required' });
                return;
            }
            const result = await git.checkoutBranch(branch, createNew, pool);
            res.json({ success: true, ...result });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // ==========================================
    // SECURITY & ACCESS CONTROL (SSAS / RBAC)
    // Dynamische Identiteit, Rollen & RLS/OLS Beleid
    // ==========================================
    // GET /security/users - List active user accounts (passwords redacted)
    router.get('/security/users', async (req, res) => {
        try {
            const users = await (0, securityStore_1.listUsers)(pool);
            res.json({ users });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /security/users - Create or update user account
    router.post('/security/users', async (req, res) => {
        try {
            const { username, password, display_name, email, role_id, claims, is_active } = req.body;
            if (!username || !display_name || !role_id) {
                res.status(400).json({ error: 'Fields "username", "display_name", and "role_id" are required' });
                return;
            }
            const user = await (0, securityStore_1.upsertUser)(pool, {
                username,
                password,
                display_name,
                email,
                role_id,
                claims: claims || {},
                is_active,
            });
            res.json({ success: true, user });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // DELETE /security/users/:id - Soft-delete user account
    router.delete('/security/users/:id', async (req, res) => {
        try {
            const success = await (0, securityStore_1.deleteUser)(pool, req.params.id);
            if (!success) {
                res.status(404).json({ error: `User ${req.params.id} not found` });
                return;
            }
            res.json({ success: true, id: req.params.id });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // GET /security/roles - List configured RBAC roles and policies from database
    router.get('/security/roles', async (req, res) => {
        try {
            const roles = await (0, securityStore_1.listRoles)(pool);
            res.json({
                sqlApiEndpoint: {
                    host: 'localhost',
                    port: parseInt(process.env.CUBEJS_PG_SQL_PORT || '15432', 10),
                    database: process.env.CUBEJS_DB_NAME || 'cubedb',
                    protocol: 'PostgreSQL Wire Protocol v3 (Superset, PowerBI, Tableau, psql)'
                },
                roles,
            });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /security/roles - Create or update role definition
    router.post('/security/roles', async (req, res) => {
        try {
            const { name, display_name, description, is_admin, can_manage_models, can_manage_datasources } = req.body;
            if (!name || !display_name) {
                res.status(400).json({ error: 'Fields "name" and "display_name" are required' });
                return;
            }
            const role = await (0, securityStore_1.upsertRole)(pool, {
                name,
                display_name,
                description,
                is_admin,
                can_manage_models,
                can_manage_datasources,
            });
            res.json({ success: true, role });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // GET /security/policies - List active RLS and OLS policies
    router.get('/security/policies', async (req, res) => {
        try {
            const roleId = req.query.roleId;
            const policies = await (0, securityStore_1.listPolicies)(pool, roleId);
            res.json({ policies });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /security/policies - Create or update policy
    router.post('/security/policies', async (req, res) => {
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
            const policy = await (0, securityStore_1.upsertPolicy)(pool, {
                id,
                role_id,
                cube_name,
                policy_type,
                definition,
            });
            res.json({ success: true, policy });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // DELETE /security/policies/:id - Delete policy
    router.delete('/security/policies/:id', async (req, res) => {
        try {
            const success = await (0, securityStore_1.deletePolicy)(pool, req.params.id);
            if (!success) {
                res.status(404).json({ error: `Policy ${req.params.id} not found` });
                return;
            }
            res.json({ success: true, id: req.params.id });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /security/test-sql - Execute SQL query against Cube SQL API as a specific role
    // Veiligheidsmaatregelen: server-side authenticatie, LIMIT 100 afgedwongen, credentials geredigeerd
    router.post('/security/test-sql', async (req, res) => {
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
        const user = await (0, securityStore_1.getUserByUsername)(pool, username);
        if (!user) {
            res.status(401).json({ success: false, user: username, error: `Gebruiker '${username}' bestaat niet of is inactief.` });
            return;
        }
        if (!user.password_hash || !(0, password_1.verifyPassword)(password, user.password_hash)) {
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
        const client = new pg_1.Client({
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
                fields: (result.fields || []).map((f) => f.name)
            });
        }
        catch (err) {
            // Redigeer wachtwoorden en gevoelige strings uit foutmeldingen
            const sanitizedMsg = (err.message || '')
                .replace(/password=\S+/gi, 'password=***')
                .replace(/:\/\/[^@]+@/, '://***@');
            res.status(400).json({
                success: false,
                user: username,
                error: sanitizedMsg
            });
        }
        finally {
            await client.end().catch(() => { });
        }
    });
    return router;
}
//# sourceMappingURL=router.js.map