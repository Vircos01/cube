import { Pool } from 'pg';
export interface ManagementServerOptions {
    port?: number;
    apiSecret?: string;
    pool?: Pool;
    corsOrigin?: string | boolean;
}
export declare function startManagementServer(options?: ManagementServerOptions): Promise<{
    app: import("express-serve-static-core").Express;
    server: import("http").Server<typeof import("http").IncomingMessage, typeof import("http").ServerResponse>;
    pool: Pool;
}>;
//# sourceMappingURL=server.d.ts.map