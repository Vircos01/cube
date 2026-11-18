import { Request, Response, NextFunction } from 'express';
export interface AuthenticatedRequest extends Request {
    id?: string;
    user?: {
        id?: string;
        role?: string;
        actor?: string;
        [key: string]: any;
    };
}
export declare function createAuthMiddleware(apiSecret?: string): (req: AuthenticatedRequest, res: Response, next: NextFunction) => void;
//# sourceMappingURL=auth.d.ts.map