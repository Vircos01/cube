import crypto from 'crypto';

/**
 * Hash a plaintext password using crypto.scrypt
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

/**
 * Verify a plaintext password against a stored hash (or plain string for seed/fallback)
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  if (!storedHash) {
    return false;
  }
  if (storedHash.startsWith('scrypt:')) {
    const parts = storedHash.split(':');
    if (parts.length !== 3) {
      return false;
    }
    const [, salt, hash] = parts;
    const computed = crypto.scryptSync(password, salt, 64).toString('hex');
    try {
      return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(hash, 'hex'));
    } catch {
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
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
