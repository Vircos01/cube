import { Pool, PoolClient } from 'pg';
import crypto from 'crypto';
import yaml from 'js-yaml';
import {
  SemanticModel,
  ModelRevision,
  SemanticModelWithActiveRevision,
  SemanticModelDetail,
  ModelType,
} from '../types';
import { withTransaction } from '../db/pool';

export async function bumpSchemaVersion(client: Pool | PoolClient): Promise<string> {
  const hash = crypto.randomBytes(8).toString('hex');
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

export async function getSchemaVersion(pool: Pool): Promise<string> {
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

export async function getActiveSchemaFiles(pool: Pool): Promise<Array<{ fileName: string; content: string }>> {
  const query = `
    SELECT sm.file_name, mr.content
    FROM semantic_models sm
    JOIN model_revisions mr ON sm.id = mr.model_id
    WHERE sm.is_active = true AND mr.status = 'active'
    ORDER BY sm.name ASC
  `;
  const res = await pool.query(query);
  return res.rows.map(row => ({
    fileName: row.file_name,
    content: row.content,
  }));
}

export async function getAllModels(pool: Pool): Promise<SemanticModelWithActiveRevision[]> {
  const query = `
    SELECT 
      sm.id, sm.name, sm.model_type, sm.file_name, sm.description, sm.is_active, sm.created_at, sm.updated_at,
      mr.id AS revision_id, mr.revision_number, mr.content, mr.content_format, mr.change_summary, mr.status AS revision_status, mr.created_by, mr.created_at AS revision_created_at
    FROM semantic_models sm
    LEFT JOIN model_revisions mr ON sm.id = mr.model_id AND mr.status = 'active'
    ORDER BY sm.name ASC
  `;
  const res = await pool.query(query);

  return res.rows.map(row => {
    const active_revision: ModelRevision | null = row.revision_id ? {
      id: row.revision_id,
      model_id: row.id,
      revision_number: row.revision_number,
      content: row.content,
      content_format: row.content_format,
      change_summary: row.change_summary,
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
      created_at: row.created_at,
      updated_at: row.updated_at,
      active_revision,
    };
  });
}

export async function getModelById(pool: Pool, id: string): Promise<SemanticModelDetail | null> {
  const modelRes = await pool.query(
    'SELECT * FROM semantic_models WHERE id = $1',
    [id]
  );
  if (modelRes.rows.length === 0) {
    return null;
  }
  const model: SemanticModel = modelRes.rows[0];

  const revisionsRes = await pool.query(
    'SELECT * FROM model_revisions WHERE model_id = $1 ORDER BY revision_number DESC',
    [id]
  );
  const revisions: ModelRevision[] = revisionsRes.rows;
  const active_revision = revisions.find(r => r.status === 'active') || null;

  return {
    ...model,
    revisions,
    active_revision,
  };
}

export async function createModel(
  pool: Pool,
  params: {
    name: string;
    model_type?: ModelType;
    file_name?: string;
    description?: string;
    content: string;
    content_format?: 'yaml' | 'json';
    change_summary?: string;
    actor?: string;
  }
): Promise<SemanticModelDetail> {
  return withTransaction(pool, async (client) => {
    const modelType = params.model_type || 'cube';
    const fileName = params.file_name || `${params.name}.${modelType}.yml`;
    const format = params.content_format || 'yaml';
    const actor = params.actor || 'system';

    // Parse JSON representation if YAML
    let parsedJson: any = null;
    try {
      parsedJson = format === 'yaml' ? yaml.load(params.content) : JSON.parse(params.content);
    } catch {
      // Ignored if parsing fails
    }

    // Insert semantic model
    const modelRes = await client.query(`
      INSERT INTO semantic_models (name, model_type, file_name, description, is_active)
      VALUES ($1, $2, $3, $4, true)
      RETURNING *
    `, [params.name, modelType, fileName, params.description || null]);
    const model: SemanticModel = modelRes.rows[0];

    // Insert revision 1
    const revisionRes = await client.query(`
      INSERT INTO model_revisions (
        model_id, revision_number, content, content_format, parsed_json, change_summary, status, created_by
      )
      VALUES ($1, 1, $2, $3, $4, $5, 'active', $6)
      RETURNING *
    `, [model.id, params.content, format, parsedJson ? JSON.stringify(parsedJson) : null, params.change_summary || 'Initial creation', actor]);
    const revision: ModelRevision = revisionRes.rows[0];

    // Audit log
    await client.query(`
      INSERT INTO audit_logs (action, model_name, revision_id, details, actor)
      VALUES ('CREATE', $1, $2, $3, $4)
    `, [model.name, revision.id, JSON.stringify({ fileName, modelType }), actor]);

    // Bump schema version
    await bumpSchemaVersion(client);

    return {
      ...model,
      revisions: [revision],
      active_revision: revision,
    };
  });
}

export async function updateModel(
  pool: Pool,
  id: string,
  params: {
    content: string;
    content_format?: 'yaml' | 'json';
    change_summary?: string;
    description?: string;
    actor?: string;
  }
): Promise<SemanticModelDetail> {
  return withTransaction(pool, async (client) => {
    const modelRes = await client.query('SELECT * FROM semantic_models WHERE id = $1', [id]);
    if (modelRes.rows.length === 0) {
      throw new Error(`Semantic model with id ${id} not found`);
    }
    const model: SemanticModel = modelRes.rows[0];

    // Determine next revision number
    const maxRevRes = await client.query(
      'SELECT COALESCE(MAX(revision_number), 0) AS max_rev FROM model_revisions WHERE model_id = $1',
      [id]
    );
    const nextRevisionNumber = parseInt(maxRevRes.rows[0].max_rev, 10) + 1;

    // Archive current active revisions
    await client.query(
      "UPDATE model_revisions SET status = 'archived' WHERE model_id = $1 AND status = 'active'",
      [id]
    );

    const format = params.content_format || 'yaml';
    const actor = params.actor || 'system';

    let parsedJson: any = null;
    try {
      parsedJson = format === 'yaml' ? yaml.load(params.content) : JSON.parse(params.content);
    } catch {
      // Ignore
    }

    // Insert new active revision
    const revRes = await client.query(`
      INSERT INTO model_revisions (
        model_id, revision_number, content, content_format, parsed_json, change_summary, status, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
      RETURNING *
    `, [
      id,
      nextRevisionNumber,
      params.content,
      format,
      parsedJson ? JSON.stringify(parsedJson) : null,
      params.change_summary || `Revision ${nextRevisionNumber}`,
      actor
    ]);
    const newRevision: ModelRevision = revRes.rows[0];

    // Update model timestamp & optional description
    const updatedModelRes = await client.query(`
      UPDATE semantic_models
      SET updated_at = NOW(),
          description = COALESCE($2, description),
          is_active = true
      WHERE id = $1
      RETURNING *
    `, [id, params.description || null]);
    const updatedModel: SemanticModel = updatedModelRes.rows[0];

    // Audit log
    await client.query(`
      INSERT INTO audit_logs (action, model_name, revision_id, details, actor)
      VALUES ('UPDATE', $1, $2, $3, $4)
    `, [model.name, newRevision.id, JSON.stringify({ revisionNumber: nextRevisionNumber, changeSummary: params.change_summary }), actor]);

    // Bump schema version for hot-reload
    await bumpSchemaVersion(client);

    const allRevsRes = await client.query(
      'SELECT * FROM model_revisions WHERE model_id = $1 ORDER BY revision_number DESC',
      [id]
    );

    return {
      ...updatedModel,
      revisions: allRevsRes.rows,
      active_revision: newRevision,
    };
  });
}

export async function rollbackModel(
  pool: Pool,
  modelId: string,
  targetRevisionNumber: number,
  actor: string = 'system'
): Promise<SemanticModelDetail> {
  return withTransaction(pool, async (client) => {
    const targetRevRes = await client.query(
      'SELECT * FROM model_revisions WHERE model_id = $1 AND revision_number = $2',
      [modelId, targetRevisionNumber]
    );
    if (targetRevRes.rows.length === 0) {
      throw new Error(`Revision ${targetRevisionNumber} not found for model ${modelId}`);
    }
    const targetRev: ModelRevision = targetRevRes.rows[0];

    // Determine next revision number to preserve non-destructive audit history
    const maxRevRes = await client.query(
      'SELECT COALESCE(MAX(revision_number), 0) AS max_rev FROM model_revisions WHERE model_id = $1',
      [modelId]
    );
    const nextRevisionNumber = parseInt(maxRevRes.rows[0].max_rev, 10) + 1;

    // Archive current active
    await client.query(
      "UPDATE model_revisions SET status = 'archived' WHERE model_id = $1 AND status = 'active'",
      [modelId]
    );

    // Insert rolled-back revision as the new active revision
    const newRevRes = await client.query(`
      INSERT INTO model_revisions (
        model_id, revision_number, content, content_format, parsed_json, change_summary, status, created_by
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
      RETURNING *
    `, [
      modelId,
      nextRevisionNumber,
      targetRev.content,
      targetRev.content_format,
      targetRev.parsed_json ? JSON.stringify(targetRev.parsed_json) : null,
      `Rollback to revision ${targetRevisionNumber}`,
      actor
    ]);
    const newRevision: ModelRevision = newRevRes.rows[0];

    const modelRes = await client.query(`
      UPDATE semantic_models
      SET updated_at = NOW(), is_active = true
      WHERE id = $1
      RETURNING *
    `, [modelId]);
    const model: SemanticModel = modelRes.rows[0];

    // Audit log
    await client.query(`
      INSERT INTO audit_logs (action, model_name, revision_id, details, actor)
      VALUES ('ROLLBACK', $1, $2, $3, $4)
    `, [model.name, newRevision.id, JSON.stringify({ rolledBackTo: targetRevisionNumber, newRevision: nextRevisionNumber }), actor]);

    // Bump schema version
    await bumpSchemaVersion(client);

    const allRevsRes = await client.query(
      'SELECT * FROM model_revisions WHERE model_id = $1 ORDER BY revision_number DESC',
      [modelId]
    );

    return {
      ...model,
      revisions: allRevsRes.rows,
      active_revision: newRevision,
    };
  });
}

export async function deleteModel(
  pool: Pool,
  id: string,
  actor: string = 'system'
): Promise<void> {
  return withTransaction(pool, async (client) => {
    const modelRes = await client.query('SELECT * FROM semantic_models WHERE id = $1', [id]);
    if (modelRes.rows.length === 0) {
      throw new Error(`Semantic model with id ${id} not found`);
    }
    const model: SemanticModel = modelRes.rows[0];

    // Soft delete: deactivate model and archive its revisions
    await client.query('UPDATE semantic_models SET is_active = false, updated_at = NOW() WHERE id = $1', [id]);
    await client.query("UPDATE model_revisions SET status = 'archived' WHERE model_id = $1", [id]);

    // Audit log
    await client.query(`
      INSERT INTO audit_logs (action, model_name, details, actor)
      VALUES ('DELETE', $1, $2, $3)
    `, [model.name, JSON.stringify({ deactivated: true }), actor]);

    // Bump schema version so Cube drops this cube/view from compiled cache
    await bumpSchemaVersion(client);
  });
}
