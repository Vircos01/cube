"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.importModelsFromDirectory = importModelsFromDirectory;
exports.exportModelsToDirectory = exportModelsToDirectory;
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
const js_yaml_1 = __importDefault(require("js-yaml"));
const modelStore_1 = require("./modelStore");
async function importModelsFromDirectory(pool, directoryPath, actor = 'system') {
    const result = {
        imported: [],
        skipped: [],
        errors: [],
    };
    if (!(await fs_extra_1.default.pathExists(directoryPath))) {
        throw new Error(`Directory ${directoryPath} does not exist`);
    }
    const entries = await fs_extra_1.default.readdir(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path_1.default.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            const subResult = await importModelsFromDirectory(pool, fullPath, actor);
            result.imported.push(...subResult.imported);
            result.skipped.push(...subResult.skipped);
            result.errors.push(...subResult.errors);
            continue;
        }
        const ext = path_1.default.extname(entry.name).toLowerCase();
        if (!['.yml', '.yaml', '.js'].includes(ext)) {
            result.skipped.push({ fileName: entry.name, reason: 'Unsupported file extension' });
            continue;
        }
        try {
            const content = await fs_extra_1.default.readFile(fullPath, 'utf8');
            const baseName = path_1.default.basename(entry.name, ext);
            let modelName = baseName.replace(/\.cube$/, '').replace(/\.view$/, '');
            let modelType = 'cube';
            if (ext === '.yml' || ext === '.yaml') {
                try {
                    const parsed = js_yaml_1.default.load(content);
                    if (parsed?.views && Array.isArray(parsed.views) && parsed.views.length > 0) {
                        modelType = 'view';
                        modelName = parsed.views[0].name || modelName;
                    }
                    else if (parsed?.cubes && Array.isArray(parsed.cubes) && parsed.cubes.length > 0) {
                        modelType = 'cube';
                        modelName = parsed.cubes[0].name || modelName;
                    }
                }
                catch {
                    // If YAML parse fails, proceed with derived modelName
                }
            }
            // Check if model already exists
            const existingRes = await pool.query('SELECT id, name FROM semantic_models WHERE name = $1', [modelName]);
            if (existingRes.rows.length === 0) {
                const created = await (0, modelStore_1.createModel)(pool, {
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
            }
            else {
                const existingId = existingRes.rows[0].id;
                const updated = await (0, modelStore_1.updateModel)(pool, existingId, {
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
        }
        catch (err) {
            result.errors.push({
                fileName: entry.name,
                error: err.message,
            });
        }
    }
    return result;
}
async function exportModelsToDirectory(pool, targetDirectory) {
    await fs_extra_1.default.ensureDir(targetDirectory);
    const query = `
    SELECT sm.file_name, mr.content
    FROM semantic_models sm
    JOIN model_revisions mr ON sm.id = mr.model_id
    WHERE sm.is_active = true AND mr.status = 'active'
    ORDER BY sm.name ASC
  `;
    const res = await pool.query(query);
    const exported = [];
    for (const row of res.rows) {
        const destPath = path_1.default.join(targetDirectory, row.file_name);
        await fs_extra_1.default.writeFile(destPath, row.content, 'utf8');
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
//# sourceMappingURL=fileMigrator.js.map