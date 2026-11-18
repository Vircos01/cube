"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.bumpSchemaVersion = bumpSchemaVersion;
exports.getSchemaVersion = getSchemaVersion;
exports.logAudit = logAudit;
exports.getActiveSchemaFiles = getActiveSchemaFiles;
exports.getAllModels = getAllModels;
exports.getModelById = getModelById;
exports.createModel = createModel;
exports.updateModel = updateModel;
exports.rollbackModel = rollbackModel;
exports.deleteModel = deleteModel;
exports.restoreModel = restoreModel;
exports.cleanupArchivedRevisions = cleanupArchivedRevisions;
exports.batchUpsertModels = batchUpsertModels;
const crypto_1 = __importDefault(require("crypto"));
const js_yaml_1 = __importDefault(require("js-yaml"));
const types_1 = require("../types");
const pool_1 = require("../db/pool");
const validator_1 = require("../compiler/validator");
async function bumpSchemaVersion(client) {
    const hash = crypto_1.default.randomBytes(8).toString('hex');
    const res = await client.query(`
    UPDATE schema_version_tracker
    SET version = version + 1,
        version_hash = $1,
        updated_at = NOW()
    WHERE id = 1
    RETURNING version, version_hash, updated_at
  `, [hash]);
    if (res.rows.length === 0) {
        // If table was somehow empty, insert row 1
        const insertRes = await client.query(`
      INSERT INTO schema_version_tracker (id, version, version_hash, updated_at)
      VALUES (1, 1, $1, NOW())
      RETURNING version, version_hash, updated_at
    `, [hash]);
        return `v${insertRes.rows[0].version}_${insertRes.rows[0].version_hash}`;
    }
    return `v${res.rows[0].version}_${res.rows[0].version_hash}`;
}
async function getSchemaVersion(pool) {
    const res = await pool.query(`
    SELECT version, version_hash, updated_at 
    FROM schema_version_tracker 
    WHERE id = 1
  `);
    if (res.rows.length === 0) {
        return 'default_schema_version';
    }
    const row = res.rows[0];
    return `v${row.version}_${row.version_hash}_${new Date(row.updated_at).getTime()}`;
}
/**
 * Log a structured, compliant audit entry
 */
async function logAudit(client, params) {
    const actor = params.actor || 'system';
    const source = params.source || 'management_api';
    const result = params.result || 'SUCCESS';
    const res = await client.query(`
    INSERT INTO audit_logs (
      action, model_id, model_name, previous_revision_id, revision_id,
      details, actor, source, result, error_message, ip_address, created_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
    RETURNING *
  `, [
        params.action,
        params.model_id || null,
        params.model_name || null,
        params.previous_revision_id || null,
        params.revision_id || null,
        params.details ? JSON.stringify(params.details) : null,
        actor,
        source,
        result,
        params.error_message || null,
        params.ip_address || null
    ]);
    return res?.rows ? res.rows[0] : {};
}
async function getActiveSchemaFiles(pool, excludeModelId) {
    let query = `
    SELECT sm.file_name, mr.content
    FROM semantic_models sm
    JOIN model_revisions mr ON sm.id = mr.model_id
    WHERE sm.is_active = true AND mr.status = 'active'
  `;
    const params = [];
    if (excludeModelId) {
        query += ' AND sm.id != $1';
        params.push(excludeModelId);
    }
    query += ' ORDER BY sm.name ASC';
    const res = await pool.query(query, params);
    return res.rows.map(row => ({
        fileName: row.file_name,
        content: row.content,
    }));
}
async function getAllModels(pool, options = {}) {
    let query = `
    SELECT 
      sm.id, sm.name, sm.model_type, sm.file_name, sm.description, sm.is_active, sm.version, sm.created_at, sm.updated_at,
      mr.id AS revision_id, mr.revision_number, mr.content, mr.content_format, mr.change_summary, mr.git_commit_hash, mr.status AS revision_status, mr.created_by, mr.created_at AS revision_created_at
    FROM semantic_models sm
    LEFT JOIN model_revisions mr ON sm.id = mr.model_id AND mr.status = 'active'
  `;
    if (!options.includeDeleted) {
        query += ' WHERE sm.is_active = true';
    }
    query += ' ORDER BY sm.name ASC';
    const res = await pool.query(query);
    return res.rows.map(row => {
        const active_revision = row.revision_id ? {
            id: row.revision_id,
            model_id: row.id,
            revision_number: row.revision_number,
            content: row.content,
            content_format: row.content_format,
            change_summary: row.change_summary,
            git_commit_hash: row.git_commit_hash,
            status: row.revision_status,
            created_by: row.created_by,
            created_at: row.revision_created_at,
        } : null;
        return {
            id: row.id,
            name: row.name,
            model_type: row.model_type,
            file_name: row.file_name,
            description: row.description,
            is_active: row.is_active,
            version: row.version || 1,
            created_at: row.created_at,
            updated_at: row.updated_at,
            active_revision,
        };
    });
}
async function getModelById(pool, id) {
    const modelRes = await pool.query('SELECT * FROM semantic_models WHERE id = $1', [id]);
    if (modelRes.rows.length === 0) {
        return null;
    }
    const model = modelRes.rows[0];
    const revisionsRes = await pool.query('SELECT * FROM model_revisions WHERE model_id = $1 ORDER BY revision_number DESC', [id]);
    const revisions = revisionsRes.rows;
    const active_revision = revisions.find(r => r.status === 'active') || null;
    return {
        ...model,
        version: model.version || 1,
        revisions,
        active_revision,
    };
}
async function createModel(pool, params) {
    return (0, pool_1.withTransaction)(pool, async (client) => {
        const modelType = params.model_type || 'cube';
        const fileName = params.file_name || `${params.name}.${modelType}.yml`;
        const format = params.content_format || 'yaml';
        const actor = params.actor || 'system';
        const source = params.source || 'management_api';
        // Parse JSON representation if YAML
        let parsedJson = null;
        try {
            parsedJson = format === 'yaml' ? js_yaml_1.default.load(params.content) : JSON.parse(params.content);
        }
        catch {
            // Ignored if parsing fails
        }
        // Insert semantic model with version = 1
        const modelRes = await client.query(`
      INSERT INTO semantic_models (name, model_type, file_name, description, is_active, version)
      VALUES ($1, $2, $3, $4, true, 1)
      RETURNING *
    `, [params.name, modelType, fileName, params.description || null]);
        const model = modelRes.rows[0];
        // Insert revision 1
        const revisionRes = await client.query(`
      INSERT INTO model_revisions (
        model_id, revision_number, content, content_format, parsed_json, change_summary, git_commit_hash, status, created_by
      )
      VALUES ($1, 1, $2, $3, $4, $5, $6, 'active', $7)
      RETURNING *
    `, [
            model.id,
            params.content,
            format,
            parsedJson ? JSON.stringify(parsedJson) : null,
            params.change_summary || 'Initial creation',
            params.git_commit_hash || null,
            actor
        ]);
        const revision = revisionRes.rows[0];
        // Audit log with mandatory fields
        await logAudit(client, {
            action: 'CREATE',
            model_id: model.id,
            model_name: model.name,
            revision_id: revision.id,
            actor,
            source,
            result: 'SUCCESS',
            details: { fileName, modelType, changeSummary: params.change_summary || 'Initial creation' }
        });
        // Bump schema version
        await bumpSchemaVersion(client);
        return {
            ...model,
            version: 1,
            revisions: [revision],
            active_revision: revision,
        };
    });
}
async function updateModel(pool, id, params) {
    const actor = params.actor || 'system';
    const source = params.source || 'management_api';
    try {
        return await (0, pool_1.withTransaction)(pool, async (client) => {
            // 1. Lock model row for update (prevents concurrent race conditions)
            const modelRes = await client.query('SELECT * FROM semantic_models WHERE id = $1 FOR UPDATE', [id]);
            if (modelRes.rows.length === 0) {
                throw new Error(`Semantic model with id ${id} not found`);
            }
            const model = modelRes.rows[0];
            // 2. Fetch current active revision
            const currentActiveRes = await client.query("SELECT * FROM model_revisions WHERE model_id = $1 AND status = 'active' ORDER BY revision_number DESC LIMIT 1", [id]);
            const currentActiveRev = currentActiveRes.rows[0] || null;
            // 3. OPTIMISTIC CONCURRENCY CONTROL:
            // If client supplied expectedRevisionNumber / expectedRevisionId / expectedVersion, check against current state
            if (params.expectedRevisionNumber !== undefined && currentActiveRev) {
                if (currentActiveRev.revision_number !== params.expectedRevisionNumber) {
                    throw new types_1.VersionConflictError(id, params.expectedRevisionNumber, currentActiveRev.revision_number, currentActiveRev.change_summary || undefined, currentActiveRev.created_by, model.name, currentActiveRev.id);
                }
            }
            if (params.expectedRevisionId !== undefined && currentActiveRev) {
                if (currentActiveRev.id !== params.expectedRevisionId) {
                    throw new types_1.VersionConflictError(id, params.expectedRevisionId, currentActiveRev.id, currentActiveRev.change_summary || undefined, currentActiveRev.created_by, model.name, currentActiveRev.id);
                }
            }
            if (params.expectedVersion !== undefined) {
                if (model.version !== params.expectedVersion) {
                    throw new types_1.VersionConflictError(id, params.expectedVersion, model.version, undefined, undefined, model.name, currentActiveRev?.id);
                }
            }
            // 4. Pre-validate content against other active models
            const otherFiles = await getActiveSchemaFiles(client, id);
            const validation = await (0, validator_1.validateSchemaContent)(params.content, model.file_name, otherFiles);
            if (!validation.valid) {
                const errMsg = validation.errors.map(e => e.message).join('; ');
                const valError = new Error(`Validatie mislukt voor model ${model.name}: ${errMsg}`);
                valError.validationErrors = validation.errors;
                throw valError;
            }
            // 5. Determine next revision number
            const maxRevRes = await client.query('SELECT COALESCE(MAX(revision_number), 0) AS max_rev FROM model_revisions WHERE model_id = $1', [id]);
            const nextRevisionNumber = parseInt(maxRevRes.rows[0].max_rev, 10) + 1;
            // 6. Archive current active revisions
            await client.query("UPDATE model_revisions SET status = 'archived' WHERE model_id = $1 AND status = 'active'", [id]);
            const format = params.content_format || 'yaml';
            let parsedJson = null;
            try {
                parsedJson = format === 'yaml' ? js_yaml_1.default.load(params.content) : JSON.parse(params.content);
            }
            catch {
                // Ignore
            }
            // 7. Insert new active revision
            const revRes = await client.query(`
        INSERT INTO model_revisions (
          model_id, revision_number, content, content_format, parsed_json, change_summary, git_commit_hash, status, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
        RETURNING *
      `, [
                id,
                nextRevisionNumber,
                params.content,
                format,
                parsedJson ? JSON.stringify(parsedJson) : null,
                params.change_summary || `Revision ${nextRevisionNumber}`,
                params.git_commit_hash || null,
                actor
            ]);
            const newRevision = revRes.rows[0];
            // 8. Update model timestamp, version counter & optional description
            const updatedModelRes = await client.query(`
        UPDATE semantic_models
        SET updated_at = NOW(),
            version = version + 1,
            description = COALESCE($2, description),
            is_active = true
        WHERE id = $1
        RETURNING *
      `, [id, params.description || null]);
            const updatedModel = updatedModelRes.rows[0];
            // 9. Audit log with mandatory fields
            await logAudit(client, {
                action: 'UPDATE',
                model_id: id,
                model_name: model.name,
                previous_revision_id: currentActiveRev?.id,
                revision_id: newRevision.id,
                actor,
                source,
                result: 'SUCCESS',
                details: {
                    revisionNumber: nextRevisionNumber,
                    previousRevisionNumber: currentActiveRev?.revision_number,
                    changeSummary: params.change_summary
                }
            });
            // 10. Bump schema version for hot-reload
            await bumpSchemaVersion(client);
            const allRevsRes = await client.query('SELECT * FROM model_revisions WHERE model_id = $1 ORDER BY revision_number DESC', [id]);
            return {
                ...updatedModel,
                revisions: allRevsRes.rows,
                active_revision: newRevision,
            };
        });
    }
    catch (err) {
        if (err instanceof types_1.VersionConflictError) {
            await logAudit(pool, {
                action: 'UPDATE',
                model_id: id,
                model_name: err.modelName,
                previous_revision_id: err.currentRevisionId,
                actor,
                source,
                result: 'FAILED',
                error_message: err.message,
            }).catch((e) => console.error('Failed to log failure audit:', e.message));
        }
        else if (err.validationErrors) {
            await logAudit(pool, {
                action: 'UPDATE',
                model_id: id,
                actor,
                source,
                result: 'FAILED',
                error_message: err.message,
            }).catch((e) => console.error('Failed to log failure audit:', e.message));
        }
        throw err;
    }
}
async function rollbackModel(pool, modelId, targetRevisionNumber, actor = 'system', source = 'management_api') {
    try {
        return await (0, pool_1.withTransaction)(pool, async (client) => {
            // 1. Lock model row for update
            const modelRes = await client.query('SELECT * FROM semantic_models WHERE id = $1 FOR UPDATE', [modelId]);
            if (modelRes.rows.length === 0) {
                throw new Error(`Semantic model with id ${modelId} not found`);
            }
            const model = modelRes.rows[0];
            // 2. Fetch current active revision
            const currentActiveRes = await client.query("SELECT * FROM model_revisions WHERE model_id = $1 AND status = 'active' ORDER BY revision_number DESC LIMIT 1", [modelId]);
            const currentActiveRev = currentActiveRes.rows[0] || null;
            // 3. Fetch target revision
            const targetRevRes = await client.query('SELECT * FROM model_revisions WHERE model_id = $1 AND revision_number = $2', [modelId, targetRevisionNumber]);
            if (targetRevRes.rows.length === 0) {
                throw new Error(`Revision ${targetRevisionNumber} not found for model ${modelId}`);
            }
            const targetRev = targetRevRes.rows[0];
            // 4. Pre-validate rolled-back content against other active models
            const otherFiles = await getActiveSchemaFiles(client, modelId);
            const validation = await (0, validator_1.validateSchemaContent)(targetRev.content, model.file_name, otherFiles);
            if (!validation.valid) {
                const errMsg = validation.errors.map(e => e.message).join('; ');
                const rollbackErr = new Error(`Rollback validatie mislukt voor model ${model.name}: ${errMsg}`);
                rollbackErr.validationErrors = validation.errors;
                throw rollbackErr;
            }
            // 5. Determine next revision number to preserve non-destructive audit history
            const maxRevRes = await client.query('SELECT COALESCE(MAX(revision_number), 0) AS max_rev FROM model_revisions WHERE model_id = $1', [modelId]);
            const nextRevisionNumber = parseInt(maxRevRes.rows[0].max_rev, 10) + 1;
            // 6. Archive current active
            await client.query("UPDATE model_revisions SET status = 'archived' WHERE model_id = $1 AND status = 'active'", [modelId]);
            // 7. Insert rolled-back revision as the new active revision
            const newRevRes = await client.query(`
        INSERT INTO model_revisions (
          model_id, revision_number, content, content_format, parsed_json, change_summary, git_commit_hash, status, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
        RETURNING *
      `, [
                modelId,
                nextRevisionNumber,
                targetRev.content,
                targetRev.content_format,
                targetRev.parsed_json ? JSON.stringify(targetRev.parsed_json) : null,
                `Rollback to revision ${targetRevisionNumber}`,
                targetRev.git_commit_hash || null,
                actor
            ]);
            const newRevision = newRevRes.rows[0];
            // 8. Update model timestamp & increment version
            const updatedModelRes = await client.query(`
        UPDATE semantic_models
        SET updated_at = NOW(),
            version = version + 1,
            is_active = true
        WHERE id = $1
        RETURNING *
      `, [modelId]);
            const updatedModel = updatedModelRes.rows[0];
            // 9. Audit log
            await logAudit(client, {
                action: 'ROLLBACK',
                model_id: modelId,
                model_name: model.name,
                previous_revision_id: currentActiveRev?.id,
                revision_id: newRevision.id,
                actor,
                source,
                result: 'SUCCESS',
                details: {
                    rolledBackTo: targetRevisionNumber,
                    newRevision: nextRevisionNumber
                }
            });
            // 10. Bump schema version
            await bumpSchemaVersion(client);
            const allRevsRes = await client.query('SELECT * FROM model_revisions WHERE model_id = $1 ORDER BY revision_number DESC', [modelId]);
            return {
                ...updatedModel,
                revisions: allRevsRes.rows,
                active_revision: newRevision,
            };
        });
    }
    catch (err) {
        if (err.validationErrors) {
            await logAudit(pool, {
                action: 'ROLLBACK',
                model_id: modelId,
                actor,
                source,
                result: 'FAILED',
                error_message: err.message,
                details: { targetRevisionNumber }
            }).catch((e) => console.error('Failed to log failure audit:', e.message));
        }
        throw err;
    }
}
async function deleteModel(pool, id, actor = 'system', source = 'management_api') {
    return (0, pool_1.withTransaction)(pool, async (client) => {
        const modelRes = await client.query('SELECT * FROM semantic_models WHERE id = $1 FOR UPDATE', [id]);
        if (modelRes.rows.length === 0) {
            throw new Error(`Semantic model with id ${id} not found`);
        }
        const model = modelRes.rows[0];
        const currentActiveRes = await client.query("SELECT * FROM model_revisions WHERE model_id = $1 AND status = 'active' ORDER BY revision_number DESC LIMIT 1", [id]);
        const currentActiveRev = currentActiveRes.rows[0] || null;
        // Soft delete: deactivate model and archive its revisions
        await client.query(`
      UPDATE semantic_models
      SET is_active = false,
          version = version + 1,
          updated_at = NOW()
      WHERE id = $1
    `, [id]);
        await client.query("UPDATE model_revisions SET status = 'archived' WHERE model_id = $1", [id]);
        // Audit log
        await logAudit(client, {
            action: 'DELETE',
            model_id: id,
            model_name: model.name,
            previous_revision_id: currentActiveRev?.id,
            actor,
            source,
            result: 'SUCCESS',
            details: { deactivated: true, softDelete: true }
        });
        // Bump schema version so Cube drops this cube/view from compiled cache
        await bumpSchemaVersion(client);
    });
}
async function restoreModel(pool, id, actor = 'system', source = 'management_api') {
    try {
        return await (0, pool_1.withTransaction)(pool, async (client) => {
            const modelRes = await client.query('SELECT * FROM semantic_models WHERE id = $1 FOR UPDATE', [id]);
            if (modelRes.rows.length === 0) {
                throw new Error(`Semantic model with id ${id} not found`);
            }
            const model = modelRes.rows[0];
            if (model.is_active) {
                throw new Error(`Model '${model.name}' is al actief`);
            }
            // Get the most recent revision
            const revRes = await client.query('SELECT * FROM model_revisions WHERE model_id = $1 ORDER BY revision_number DESC LIMIT 1', [id]);
            if (revRes.rows.length === 0) {
                throw new Error(`Geen revisies gevonden om te herstellen voor model ${model.name}`);
            }
            const latestRev = revRes.rows[0];
            // Pre-validate that restoring this model doesn't break schema compiler
            const activeFiles = await getActiveSchemaFiles(client);
            const validation = await (0, validator_1.validateSchemaContent)(latestRev.content, model.file_name, activeFiles);
            if (!validation.valid) {
                const errMsg = validation.errors.map(e => e.message).join('; ');
                const restoreErr = new Error(`Herstel mislukt voor model ${model.name}: ${errMsg}`);
                restoreErr.validationErrors = validation.errors;
                throw restoreErr;
            }
            // Activate latest revision
            await client.query("UPDATE model_revisions SET status = 'active' WHERE id = $1", [latestRev.id]);
            // Reactivate model & increment version
            const updatedModelRes = await client.query(`
        UPDATE semantic_models
        SET is_active = true,
            version = version + 1,
            updated_at = NOW()
        WHERE id = $1
        RETURNING *
      `, [id]);
            const updatedModel = updatedModelRes.rows[0];
            // Audit log
            await logAudit(client, {
                action: 'RESTORE',
                model_id: id,
                model_name: model.name,
                revision_id: latestRev.id,
                actor,
                source,
                result: 'SUCCESS',
                details: { revisionRestored: latestRev.revision_number }
            });
            // Bump schema version
            await bumpSchemaVersion(client);
            const allRevsRes = await client.query('SELECT * FROM model_revisions WHERE model_id = $1 ORDER BY revision_number DESC', [id]);
            return {
                ...updatedModel,
                revisions: allRevsRes.rows,
                active_revision: { ...latestRev, status: 'active' },
            };
        });
    }
    catch (err) {
        if (err.validationErrors) {
            await logAudit(pool, {
                action: 'RESTORE',
                model_id: id,
                actor,
                source,
                result: 'FAILED',
                error_message: err.message,
            }).catch((e) => console.error('Failed to log failure audit:', e.message));
        }
        throw err;
    }
}
async function cleanupArchivedRevisions(pool, options = {}) {
    const retentionDays = options.retentionDays || 90;
    const keepMinRevisions = options.keepMinRevisions || 5;
    const actor = options.actor || 'system';
    return (0, pool_1.withTransaction)(pool, async (client) => {
        // Delete revisions that are status = 'archived', older than retentionDays,
        // but ALWAYS keeping at least the keepMinRevisions most recent revisions per model.
        const res = await client.query(`
      WITH ranked_revisions AS (
        SELECT id, model_id, revision_number, created_at, status,
               ROW_NUMBER() OVER (PARTITION BY model_id ORDER BY revision_number DESC) AS rank
        FROM model_revisions
      )
      DELETE FROM model_revisions
      WHERE id IN (
        SELECT id FROM ranked_revisions
        WHERE status = 'archived'
          AND rank > $1
          AND created_at < NOW() - ($2 || ' days')::INTERVAL
      )
      RETURNING id
    `, [keepMinRevisions, retentionDays]);
        const deletedCount = res.rows.length;
        if (deletedCount > 0) {
            await logAudit(client, {
                action: 'CLEANUP_REVISIONS',
                actor,
                source: 'retention_policy',
                result: 'SUCCESS',
                details: { deletedCount, retentionDays, keepMinRevisions }
            });
        }
        return { deletedCount };
    });
}
async function batchUpsertModels(pool, items, actor = 'system', source = 'batch_import') {
    if (items.length === 0) {
        return [];
    }
    return (0, pool_1.withTransaction)(pool, async (client) => {
        const results = [];
        for (const item of items) {
            const modelType = item.model_type || 'cube';
            const fileName = item.file_name || `${item.name}.${modelType}.yml`;
            const format = item.content_format || 'yaml';
            let parsedJson = null;
            try {
                parsedJson = format === 'yaml' ? js_yaml_1.default.load(item.content) : JSON.parse(item.content);
            }
            catch {
                // Ignored
            }
            // Check if model already exists
            const existingRes = await client.query('SELECT * FROM semantic_models WHERE name = $1 FOR UPDATE', [item.name]);
            if (existingRes.rows.length > 0) {
                const existingModel = existingRes.rows[0];
                const modelId = existingModel.id;
                // Fetch current active revision
                const currentActiveRes = await client.query("SELECT * FROM model_revisions WHERE model_id = $1 AND status = 'active' ORDER BY revision_number DESC LIMIT 1", [modelId]);
                const currentActiveRev = currentActiveRes.rows[0] || null;
                // Determine next revision number
                const maxRevRes = await client.query('SELECT COALESCE(MAX(revision_number), 0) AS max_rev FROM model_revisions WHERE model_id = $1', [modelId]);
                const nextRevNum = parseInt(maxRevRes.rows[0].max_rev, 10) + 1;
                // Archive previous active revision
                await client.query("UPDATE model_revisions SET status = 'archived' WHERE model_id = $1 AND status = 'active'", [modelId]);
                // Insert new active revision
                const revRes = await client.query(`
          INSERT INTO model_revisions (
            model_id, revision_number, content, content_format, parsed_json, change_summary, git_commit_hash, status, created_by
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
          RETURNING *
        `, [
                    modelId,
                    nextRevNum,
                    item.content,
                    format,
                    parsedJson ? JSON.stringify(parsedJson) : null,
                    item.change_summary || `Batch revision ${nextRevNum}`,
                    item.git_commit_hash || null,
                    actor
                ]);
                // Update model metadata & version
                const updatedModelRes = await client.query(`
          UPDATE semantic_models
          SET updated_at = NOW(),
              version = version + 1,
              description = COALESCE($2, description),
              is_active = true
          WHERE id = $1
          RETURNING *
        `, [modelId, item.description || null]);
                // Audit log
                await logAudit(client, {
                    action: 'UPDATE',
                    model_id: modelId,
                    model_name: item.name,
                    previous_revision_id: currentActiveRev?.id,
                    revision_id: revRes.rows[0].id,
                    actor,
                    source,
                    result: 'SUCCESS',
                    details: { revisionNumber: nextRevNum, changeSummary: item.change_summary }
                });
                results.push({
                    model: updatedModelRes.rows[0],
                    revision: revRes.rows[0],
                    isUpdate: true,
                });
            }
            else {
                // Insert new semantic model with version = 1
                const modelRes = await client.query(`
          INSERT INTO semantic_models (name, model_type, file_name, description, is_active, version)
          VALUES ($1, $2, $3, $4, true, 1)
          RETURNING *
        `, [item.name, modelType, fileName, item.description || null]);
                const model = modelRes.rows[0];
                // Insert revision 1
                const revRes = await client.query(`
          INSERT INTO model_revisions (
            model_id, revision_number, content, content_format, parsed_json, change_summary, git_commit_hash, status, created_by
          )
          VALUES ($1, 1, $2, $3, $4, $5, $6, 'active', $7)
          RETURNING *
        `, [
                    model.id,
                    item.content,
                    format,
                    parsedJson ? JSON.stringify(parsedJson) : null,
                    item.change_summary || 'Initial creation (batch import)',
                    item.git_commit_hash || null,
                    actor
                ]);
                // Audit log
                await logAudit(client, {
                    action: 'CREATE',
                    model_id: model.id,
                    model_name: item.name,
                    revision_id: revRes.rows[0].id,
                    actor,
                    source,
                    result: 'SUCCESS',
                    details: { fileName, modelType }
                });
                results.push({
                    model,
                    revision: revRes.rows[0],
                    isUpdate: false,
                });
            }
        }
        // Atomic schemaVersion bump: EXACTLY ONCE for the entire batch
        await bumpSchemaVersion(client);
        return results;
    });
}
//# sourceMappingURL=modelStore.js.map