import { Router } from 'express';
import { Pool } from 'pg';
import { GitService } from '../git/gitService';
export declare function createManagementRouter(pool: Pool, options?: {
    apiSecret?: string;
    gitService?: GitService;
}): Router;
//# sourceMappingURL=router.d.ts.map