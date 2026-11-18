"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runMigrations = runMigrations;
const fs_extra_1 = __importDefault(require("fs-extra"));
const path_1 = __importDefault(require("path"));
async function runMigrations(pool, options = {}) {
    const sqlDir = path_1.default.resolve(__dirname, '../../sql');
    if (!(await fs_extra_1.default.pathExists(sqlDir))) {
        throw new Error(`SQL directory not found at ${sqlDir}`);
    }
    const files = (await fs_extra_1.default.readdir(sqlDir)).filter(f => f.endsWith('.sql')).sort();
    for (const file of files) {
        if (file.includes('sample_data') && !options.includeSampleData) {
            continue;
        }
        const filePath = path_1.default.join(sqlDir, file);
        const sql = await fs_extra_1.default.readFile(filePath, 'utf8');
        await pool.query(sql);
    }
}
//# sourceMappingURL=migrator.js.map