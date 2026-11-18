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
const modelStore_1 = require("../repository/modelStore");
const validator_1 = require("../compiler/validator");
const introspect_1 = require("./introspect");
const auth_1 = require("./auth");
const fileMigrator_1 = require("../repository/fileMigrator");
function createManagementRouter(pool, options = {}) {
    const router = (0, express_1.Router)();
    const auth = (0, auth_1.createAuthMiddleware)(options.apiSecret);
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
            const models = await (0, modelStore_1.getAllModels)(pool);
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
            const { name, model_type = 'cube', file_name, description, content, content_format = 'yaml', change_summary, skip_validation = false, } = req.body;
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
            const actor = req.user?.actor || 'system';
            const created = await (0, modelStore_1.createModel)(pool, {
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
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // PUT /models/:id - Update model content (creates a new revision and bumps version)
    router.put('/models/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const { content, content_format = 'yaml', change_summary, description, skip_validation = false } = req.body;
            if (!content) {
                res.status(400).json({ error: 'Field "content" is required' });
                return;
            }
            const existing = await (0, modelStore_1.getModelById)(pool, id);
            if (!existing) {
                res.status(404).json({ error: `Model ${id} not found` });
                return;
            }
            if (!skip_validation) {
                const existingFiles = await (0, modelStore_1.getActiveSchemaFiles)(pool);
                const validation = await (0, validator_1.validateSchemaContent)(content, existing.file_name, existingFiles);
                if (!validation.valid) {
                    res.status(422).json({
                        error: 'Validation failed',
                        validation,
                    });
                    return;
                }
            }
            const actor = req.user?.actor || 'system';
            const updated = await (0, modelStore_1.updateModel)(pool, id, {
                content,
                content_format,
                change_summary,
                description,
                actor,
            });
            res.json({ model: updated });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // POST /models/:id/rollback/:revisionNumber - Rollback to older revision
    router.post('/models/:id/rollback/:revisionNumber', async (req, res) => {
        try {
            const { id, revisionNumber } = req.params;
            const revNum = parseInt(revisionNumber, 10);
            if (isNaN(revNum)) {
                res.status(400).json({ error: 'Revision number must be an integer' });
                return;
            }
            const actor = req.user?.actor || 'system';
            const rolledBack = await (0, modelStore_1.rollbackModel)(pool, id, revNum, actor);
            res.json({ model: rolledBack });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // DELETE /models/:id - Deactivate model
    router.delete('/models/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const actor = req.user?.actor || 'system';
            await (0, modelStore_1.deleteModel)(pool, id, actor);
            res.json({ success: true, message: `Model ${id} deactivated` });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    // GET /datasources/introspect - Inspect database tables and columns
    router.get('/datasources/introspect', async (req, res) => {
        try {
            const schema = req.query.schema || 'public';
            const result = await (0, introspect_1.introspectPostgresDatabase)(pool, schema);
            res.json(result);
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
    // GET /audit-logs - View audit trail
    router.get('/audit-logs', async (req, res) => {
        try {
            const limit = parseInt(req.query.limit || '50', 10);
            const query = `
        SELECT * FROM audit_logs 
        ORDER BY created_at DESC 
        LIMIT $1
      `;
            const result = await pool.query(query, [limit]);
            res.json({ auditLogs: result.rows });
        }
        catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
    return router;
}
//# sourceMappingURL=router.js.map