"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = exports.Logger = void 0;
exports.redactSensitiveData = redactSensitiveData;
const async_hooks_1 = require("async_hooks");
const asyncLocalStorage = new async_hooks_1.AsyncLocalStorage();
const SENSITIVE_KEYS = new Set([
    'password',
    'password_hash',
    'passwordhash',
    'pass',
    'secret',
    'api_secret',
    'apisecret',
    'token',
    'jwt',
    'authorization',
    'auth',
    'cookie',
    'credentials',
]);
/**
 * Recursively redacts sensitive fields from objects/arrays/strings.
 */
function redactSensitiveData(data, seen = new WeakSet()) {
    if (data === null || data === undefined)
        return data;
    if (typeof data === 'string') {
        // Redact password from postgres connection string: postgres://user:pass@host...
        return data.replace(/(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@)/gi, '$1[REDACTED]$3');
    }
    if (typeof data !== 'object')
        return data;
    // Prevent circular references
    if (seen.has(data))
        return '[Circular]';
    seen.add(data);
    if (Array.isArray(data)) {
        return data.map(item => redactSensitiveData(item, seen));
    }
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
        const lowerKey = key.toLowerCase();
        if (SENSITIVE_KEYS.has(lowerKey) || lowerKey.includes('password') || lowerKey.includes('secret')) {
            sanitized[key] = '[REDACTED]';
        }
        else {
            sanitized[key] = redactSensitiveData(value, seen);
        }
    }
    return sanitized;
}
class Logger {
    isProduction;
    constructor() {
        this.isProduction = process.env.NODE_ENV === 'production';
    }
    runWithContext(context, fn) {
        return asyncLocalStorage.run(context, fn);
    }
    getContext() {
        return asyncLocalStorage.getStore();
    }
    formatMessage(level, message, meta) {
        const context = this.getContext() || {};
        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level: level.toUpperCase(),
            message,
            ...(context.requestId ? { requestId: context.requestId } : {}),
            ...(context.actor ? { actor: context.actor } : {}),
            ...(context.source ? { source: context.source } : {}),
        };
        if (meta !== undefined) {
            if (meta instanceof Error) {
                logEntry.error = {
                    name: meta.name,
                    message: redactSensitiveData(meta.message),
                    stack: this.isProduction ? undefined : meta.stack,
                };
            }
            else {
                logEntry.meta = redactSensitiveData(meta);
            }
        }
        if (this.isProduction) {
            return JSON.stringify(logEntry);
        }
        // Dev format: readable colorized output
        const reqStr = context.requestId ? ` [${context.requestId.slice(0, 8)}]` : '';
        const metaStr = meta ? ` ${JSON.stringify(redactSensitiveData(meta))}` : '';
        return `[${timestamp}] [${level.toUpperCase()}]${reqStr} ${message}${metaStr}`;
    }
    debug(message, meta) {
        if (process.env.DEBUG || process.env.LOG_LEVEL === 'debug') {
            console.debug(this.formatMessage('debug', message, meta));
        }
    }
    info(message, meta) {
        console.log(this.formatMessage('info', message, meta));
    }
    warn(message, meta) {
        console.warn(this.formatMessage('warn', message, meta));
    }
    error(message, meta) {
        console.error(this.formatMessage('error', message, meta));
    }
}
exports.Logger = Logger;
exports.logger = new Logger();
//# sourceMappingURL=logger.js.map