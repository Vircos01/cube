import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import { Pool } from 'pg';
import { createModel, updateModel } from './modelStore';

export interface ImportResult {
  imported: Array<{ fileName: string; modelName: string; revision: number }>;
  skipped: Array<{ fileName: string; reason: string }>;
  errors: Array<{ fileName: string; error: string }>;
}

export interface ExportResult {
  exported: Array<{ fileName: string; path: string }>;
  count: number;
}

export async function importModelsFromDirectory(
  pool: Pool,
  directoryPath: string,
  actor: string = 'system'
): Promise<ImportResult> {
  const result: ImportResult = {
    imported: [],
    skipped: [],
    errors: [],
  };

  if (!(await fs.pathExists(directoryPath))) {
    throw new Error(`Directory ${directoryPath} does not exist`);
  }

  const entries = await fs.readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);

    if (entry.isDirectory()) {
      const subResult = await importModelsFromDirectory(pool, fullPath, actor);
      result.imported.push(...subResult.imported);
      result.skipped.push(...subResult.skipped);
      result.errors.push(...subResult.errors);
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!['.yml', '.yaml', '.js'].includes(ext)) {
      result.skipped.push({ fileName: entry.name, reason: 'Unsupported file extension' });
      continue;
    }

    try {
      const content = await fs.readFile(fullPath, 'utf8');
      const baseName = path.basename(entry.name, ext);
      let modelName = baseName.replace(/\.cube$/, '').replace(/\.view$/, '');
      let modelType: 'cube' | 'view' = 'cube';

      if (ext === '.yml' || ext === '.yaml') {
        try {
          const parsed: any = yaml.load(content);
          if (parsed?.views && Array.isArray(parsed.views) && parsed.views.length > 0) {
            modelType = 'view';
            modelName = parsed.views[0].name || modelName;
          } else if (parsed?.cubes && Array.isArray(parsed.cubes) && parsed.cubes.length > 0) {
            modelType = 'cube';
            modelName = parsed.cubes[0].name || modelName;
          }
        } catch {
          // If YAML parse fails, proceed with derived modelName
        }
      }

      // Check if model already exists
      const existingRes = await pool.query(
        'SELECT id, name FROM semantic_models WHERE name = $1',
        [modelName]
      );

      if (existingRes.rows.length === 0) {
        const created = await createModel(pool, {
          name: modelName,
          model_type: modelType,
          file_name: entry.name,
          content,
          content_format: ext === '.js' ? 'yaml' : 'yaml',
          change_summary: `Imported from ${entry.name}`,
          actor,
        });
        result.imported.push({
          fileName: entry.name,
          modelName,
          revision: created.active_revision?.revision_number || 1,
        });
      } else {
        const existingId = existingRes.rows[0].id;
        const updated = await updateModel(pool, existingId, {
          content,
          change_summary: `Re-imported from ${entry.name}`,
          actor,
        });
        result.imported.push({
          fileName: entry.name,
          modelName,
          revision: updated.active_revision?.revision_number || 2,
        });
      }
    } catch (err: any) {
      result.errors.push({
        fileName: entry.name,
        error: err.message,
      });
    }
  }

  return result;
}

export async function exportModelsToDirectory(
  pool: Pool,
  targetDirectory: string
): Promise<ExportResult> {
  await fs.ensureDir(targetDirectory);

  const query = `
    SELECT sm.file_name, mr.content
    FROM semantic_models sm
    JOIN model_revisions mr ON sm.id = mr.model_id
    WHERE sm.is_active = true AND mr.status = 'active'
    ORDER BY sm.name ASC
  `;
  const res = await pool.query(query);

  const exported: Array<{ fileName: string; path: string }> = [];

  for (const row of res.rows) {
    const destPath = path.join(targetDirectory, row.file_name);
    await fs.writeFile(destPath, row.content, 'utf8');
    exported.push({
      fileName: row.file_name,
      path: destPath,
    });
  }

  return {
    exported,
    count: exported.length,
  };
}
