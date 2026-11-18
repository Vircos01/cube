"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostgresSchemaRepository = void 0;
exports.createPostgresRepository = createPostgresRepository;
const modelStore_1 = require("./modelStore");
class PostgresSchemaRepository {
    pool;
    virtualPath;
    constructor(pool, virtualPath = '/cube/conf/schema') {
        this.pool = pool;
        this.virtualPath = virtualPath;
    }
    localPath() {
        return this.virtualPath;
    }
    async dataSchemaFiles() {
        const files = await (0, modelStore_1.getActiveSchemaFiles)(this.pool);
        return files.map(file => ({
            fileName: file.fileName,
            content: file.content,
            readOnly: false,
        }));
    }
}
exports.PostgresSchemaRepository = PostgresSchemaRepository;
function createPostgresRepository(pool, virtualPath) {
    return new PostgresSchemaRepository(pool, virtualPath);
}
//# sourceMappingURL=PostgresSchemaRepository.js.map