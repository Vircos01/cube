"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSchemaVersionGetter = createSchemaVersionGetter;
const modelStore_1 = require("./modelStore");
function createSchemaVersionGetter(pool) {
    return async function schemaVersion() {
        try {
            return await (0, modelStore_1.getSchemaVersion)(pool);
        }
        catch (err) {
            console.error('[createSchemaVersionGetter] Error fetching schema version from PostgreSQL:', err.message);
            return 'fallback_schema_version';
        }
    };
}
//# sourceMappingURL=schemaVersion.js.map