"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.hashPassword = hashPassword;
exports.verifyPassword = verifyPassword;
const crypto_1 = __importDefault(require("crypto"));
/**
 * Hash a plaintext password using crypto.scrypt
 */
function hashPassword(password) {
    const salt = crypto_1.default.randomBytes(16).toString('hex');
    const hash = crypto_1.default.scryptSync(password, salt, 64).toString('hex');
    return `scrypt:${salt}:${hash}`;
}
/**
 * Verify a plaintext password against a stored hash (or plain string for seed/fallback)
 */
function verifyPassword(password, storedHash) {
    if (!storedHash) {
        return false;
    }
    if (storedHash.startsWith('scrypt:')) {
        const parts = storedHash.split(':');
        if (parts.length !== 3) {
            return false;
        }
        const [, salt, hash] = parts;
        const computed = crypto_1.default.scryptSync(password, salt, 64).toString('hex');
        try {
            return crypto_1.default.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
        }
        catch {
            return false;
        }
    }
    // Constant-time compare fallback for demo/seed passwords
    try {
        const a = Buffer.from(password);
        const b = Buffer.from(storedHash);
        if (a.length !== b.length) {
            return false;
        }
        return crypto_1.default.timingSafeEqual(a, b);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=password.js.map