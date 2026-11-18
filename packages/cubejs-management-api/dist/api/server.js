"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startManagementServer = startManagementServer;
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const crypto_1 = __importDefault(require("crypto"));
const router_1 = require("./router");
const pool_1 = require("../db/pool");
const migrator_1 = require("../db/migrator");
const logger_1 = require("../observability/logger");
const metrics_1 = require("../observability/metrics");
async function startManagementServer(options = {}) {
    const port = options.port || (process.env.MANAGEMENT_PORT ? parseInt(process.env.MANAGEMENT_PORT, 10) : 4001);
    const pool = options.pool || (0, pool_1.getOrCreatePool)();
    // Run migrations
    try {
        await (0, migrator_1.runMigrations)(pool, { includeSampleData: true });
        logger_1.logger.info('✓ Metadata tables and sample data initialized in PostgreSQL');
    }
    catch (err) {
        logger_1.logger.warn('Note on migrations:', err.message);
    }
    const app = (0, express_1.default)();
    app.use((0, cors_1.default)(options.corsOrigin ? { origin: options.corsOrigin } : { origin: '*' }));
    app.use(express_1.default.json({ limit: '10mb' }));
    // 1. Correlation ID & Structured Request Logging Middleware
    app.use((req, res, next) => {
        const rawId = req.headers['x-request-id'] || req.headers['x-correlation-id'];
        const requestId = (typeof rawId === 'string' && rawId.trim()) ? rawId.trim() : crypto_1.default.randomUUID();
        req.id = requestId;
        res.setHeader('X-Request-Id', requestId);
        const startTime = Date.now();
        res.on('finish', () => {
            const durationMs = Date.now() - startTime;
            const routePath = req.baseUrl + (req.route?.path || req.path);
            const isStatic = req.path.startsWith('/admin') && (req.path.endsWith('.js') || req.path.endsWith('.css') || req.path.endsWith('.png'));
            metrics_1.metrics.recordRequest(req.method, routePath, res.statusCode, durationMs);
            if (!isStatic) {
                logger_1.logger.info(`${req.method} ${req.path} -> ${res.statusCode} (${durationMs}ms)`, {
                    type: 'http_access',
                    method: req.method,
                    path: req.path,
                    status: res.statusCode,
                    durationMs,
                    userAgent: req.headers['user-agent'],
                });
            }
        });
        logger_1.logger.runWithContext({ requestId }, () => next());
    });
    // Mount management router
    app.use('/management/v1', (0, router_1.createManagementRouter)(pool, { apiSecret: options.apiSecret }));
    // Mount web-ui directly on /admin
    app.use('/', (0, router_1.createManagementRouter)(pool, { apiSecret: options.apiSecret }));
    // 2. Safe Global Error Handler (Fase 5: Geen credential leaks / sanitized errors in production)
    app.use((err, req, res, next) => {
        const requestId = req.id;
        logger_1.logger.error(`Unhandled API error on ${req.method} ${req.path}: ${err.message}`, err);
        if (res.headersSent) {
            return next(err);
        }
        const statusCode = err.status || err.statusCode || 500;
        const isProd = process.env.NODE_ENV === 'production';
        res.status(statusCode).json({
            error: isProd ? 'Internal Server Error' : err.message,
            requestId,
            ...(isProd ? {} : { stack: err.stack }),
            ...(err.code ? { code: err.code } : {}),
            ...(err.validationErrors ? { validationErrors: err.validationErrors } : {}),
        });
    });
    const server = app.listen(port, () => {
        logger_1.logger.info(`🚀 VAS (Voxel Analytics Service) Web-UI running on http://localhost:${port}/admin`);
    });
    return { app, server, pool };
}
//# sourceMappingURL=server.js.map