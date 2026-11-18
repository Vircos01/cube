import express, { Router, Response } from 'express';
import path from 'path';
import { Pool } from 'pg';
import {
  getAllModels,
  getModelById,
  createModel,
  updateModel,
  rollbackModel,
  deleteModel,
  getSchemaVersion,
  getActiveSchemaFiles,
} from '../repository/modelStore';
import { validateSchemaContent } from '../compiler/validator';
import { introspectPostgresDatabase } from './introspect';
import { createAuthMiddleware, AuthenticatedRequest } from './auth';
import { importModelsFromDirectory, exportModelsToDirectory } from '../repository/fileMigrator';

export function createManagementRouter(pool: Pool, options: { apiSecret?: string } = {}): Router {
  const router = Router();
  const auth = createAuthMiddleware(options.apiSecret);

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

  // GET /datasources/introspect - Inspect database tables and columns
  router.get('/datasources/introspect', async (req: AuthenticatedRequest, res: Response) => {
    try {
      const schema = (req.query.schema as string) || 'public';
      const result = await introspectPostgresDatabase(pool, schema);
      res.json(result);
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

  return router;
}
