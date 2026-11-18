"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startManagementServer = startManagementServer;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const router_1 = require("./router");
const pool_1 = require("../db/pool");
const migrator_1 = require("../db/migrator");
async function startManagementServer(options = {}) {
    const port = options.port || (process.env.MANAGEMENT_PORT ? parseInt(process.env.MANAGEMENT_PORT, 10) : 4001);
    const pool = options.pool || (0, pool_1.getOrCreatePool)();
    // Run migrations
    try {
        await (0, migrator_1.runMigrations)(pool, { includeSampleData: true });
        console.log('✓ Metadata tables and sample data initialized in PostgreSQL');
    }
    catch (err) {
        console.warn('Note on migrations:', err.message);
    }
    const app = (0, express_1.default)();
    app.use((0, cors_1.default)(options.corsOrigin ? { origin: options.corsOrigin } : { origin: '*' }));
    app.use(express_1.default.json({ limit: '10mb' }));
    // Mount management router
    app.use('/management/v1', (0, router_1.createManagementRouter)(pool, { apiSecret: options.apiSecret }));
    // Mount web-ui directly on /admin
    app.use('/', (0, router_1.createManagementRouter)(pool, { apiSecret: options.apiSecret }));
    const server = app.listen(port, () => {
        console.log(`🚀 Cube Management API & Web-UI running on http://localhost:${port}/admin`);
    });
    return { app, server, pool };
}
//# sourceMappingURL=server.js.map