export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export interface LogContext {
    requestId?: string;
    actor?: string;
    source?: string;
    [key: string]: any;
}
/**
 * Recursively redacts sensitive fields from objects/arrays/strings.
 */
export declare function redactSensitiveData(data: any, seen?: WeakSet<WeakKey>): any;
export declare class Logger {
    private isProduction;
    constructor();
    runWithContext<T>(context: LogContext, fn: () => T): T;
    getContext(): LogContext | undefined;
    private formatMessage;
    debug(message: string, meta?: any): void;
    info(message: string, meta?: any): void;
    warn(message: string, meta?: any): void;
    error(message: string, meta?: any): void;
}
export declare const logger: Logger;
//# sourceMappingURL=logger.d.ts.map