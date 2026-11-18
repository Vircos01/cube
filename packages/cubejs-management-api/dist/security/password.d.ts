/**
 * Hash a plaintext password using crypto.scrypt
 */
export declare function hashPassword(password: string): string;
/**
 * Verify a plaintext password against a stored hash (or plain string for seed/fallback)
 */
export declare function verifyPassword(password: string, storedHash: string): boolean;
//# sourceMappingURL=password.d.ts.map