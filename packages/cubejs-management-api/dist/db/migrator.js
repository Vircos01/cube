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
    const initialSchemaPath = path_1.default.join(sqlDir, '001_initial_schema.sql');
    if (await fs_extra_1.default.pathExists(initialSchemaPath)) {
        const initialSchemaSql = await fs_extra_1.default.readFile(initialSchemaPath, 'utf8');
        await pool.query(initialSchemaSql);
    }
    else {
        throw new Error(`Migration file not found at ${initialSchemaPath}`);
    }
    if (options.includeSampleData) {
        const sampleDataPath = path_1.default.join(sqlDir, '002_sample_data.sql');
        if (await fs_extra_1.default.pathExists(sampleDataPath)) {
            const sampleDataSql = await fs_extra_1.default.readFile(sampleDataPath, 'utf8');
            await pool.query(sampleDataSql);
        }
    }
    const securityRolesPath = path_1.default.join(sqlDir, '004_security_roles.sql');
    if (await fs_extra_1.default.pathExists(securityRolesPath)) {
        const securityRolesSql = await fs_extra_1.default.readFile(securityRolesPath, 'utf8');
        await pool.query(securityRolesSql);
    }
}
//# sourceMappingURL=migrator.js.map