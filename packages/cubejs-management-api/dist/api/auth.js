"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createAuthMiddleware = createAuthMiddleware;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
function createAuthMiddleware(apiSecret) {
    const secret = apiSecret || process.env.CUBEJS_API_SECRET || 'secret';
    const isDevMode = process.env.CUBEJS_DEV_MODE === 'true';
    return function authMiddleware(req, res, next) {
        const authHeader = req.headers.authorization;
        // In dev mode, allow unauthenticated access if no header is present
        if (!authHeader) {
            if (isDevMode) {
                req.user = { id: 'dev-user', role: 'admin', actor: 'dev-mode' };
                return next();
            }
            res.status(401).json({ error: 'Authorization header is required (Bearer <token_or_secret>)' });
            return;
        }
        const parts = authHeader.split(' ');
        if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
            res.status(401).json({ error: 'Invalid Authorization header format. Expected Bearer <token>' });
            return;
        }
        const token = parts[1];
        // Check if token matches raw API secret directly (API Key mode)
        if (token === secret) {
            req.user = { id: 'api-key-user', role: 'admin', actor: 'api-key' };
            return next();
        }
        // Otherwise, verify as signed JWT
        try {
            const decoded = jsonwebtoken_1.default.verify(token, secret);
            req.user = {
                ...decoded,
                actor: decoded.sub || decoded.email || decoded.username || 'jwt-user',
            };
            return next();
        }
        catch (err) {
            res.status(401).json({ error: `Authentication failed: ${err.message}` });
            return;
        }
    };
}
//# sourceMappingURL=auth.js.map