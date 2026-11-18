import { AsyncLocalStorage } from 'async_hooks';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  requestId?: string;
  actor?: string;
  source?: string;
  [key: string]: any;
}

const asyncLocalStorage = new AsyncLocalStorage<LogContext>();

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
export function redactSensitiveData(data: any, seen = new WeakSet()): any {
  if (data === null || data === undefined) return data;

  if (typeof data === 'string') {
    // Redact password from postgres connection string: postgres://user:pass@host...
    return data.replace(/(postgres(?:ql)?:\/\/[^:]+:)([^@]+)(@)/gi, '$1[REDACTED]$3');
  }

  if (typeof data !== 'object') return data;

  // Prevent circular references
  if (seen.has(data)) return '[Circular]';
  seen.add(data);

  if (Array.isArray(data)) {
    return data.map(item => redactSensitiveData(item, seen));
  }

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lowerKey) || lowerKey.includes('password') || lowerKey.includes('secret')) {
      sanitized[key] = '[REDACTED]';
    } else {
      sanitized[key] = redactSensitiveData(value, seen);
    }
  }

  return sanitized;
}

export class Logger {
  private isProduction: boolean;

  constructor() {
    this.isProduction = process.env.NODE_ENV === 'production';
  }

  public runWithContext<T>(context: LogContext, fn: () => T): T {
    return asyncLocalStorage.run(context, fn);
  }

  public getContext(): LogContext | undefined {
    return asyncLocalStorage.getStore();
  }

  private formatMessage(level: LogLevel, message: string, meta?: any): string {
    const context = this.getContext() || {};
    const timestamp = new Date().toISOString();

    const logEntry: Record<string, any> = {
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
      } else {
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

  public debug(message: string, meta?: any): void {
    if (process.env.DEBUG || process.env.LOG_LEVEL === 'debug') {
      console.debug(this.formatMessage('debug', message, meta));
    }
  }

  public info(message: string, meta?: any): void {
    console.log(this.formatMessage('info', message, meta));
  }

  public warn(message: string, meta?: any): void {
    console.warn(this.formatMessage('warn', message, meta));
  }

  public error(message: string, meta?: any): void {
    console.error(this.formatMessage('error', message, meta));
  }
}

export const logger = new Logger();
