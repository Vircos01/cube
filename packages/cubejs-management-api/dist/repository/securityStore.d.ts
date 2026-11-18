import { Pool } from 'pg';
import { SecurityRole, UserAccount, AccessPolicy } from '../types';
export declare function getUserByUsername(pool: Pool, username: string): Promise<(UserAccount & {
    is_admin: boolean;
}) | null>;
export declare function listUsers(pool: Pool): Promise<Array<Omit<UserAccount, 'password_hash'>>>;
export declare function upsertUser(pool: Pool, input: {
    username: string;
    password?: string;
    display_name: string;
    email?: string;
    role_id: string;
    claims?: Record<string, any>;
    is_active?: boolean;
}): Promise<Omit<UserAccount, 'password_hash'>>;
export declare function deleteUser(pool: Pool, idOrUsername: string): Promise<boolean>;
export declare function listRoles(pool: Pool): Promise<SecurityRole[]>;
export declare function upsertRole(pool: Pool, input: {
    name: string;
    display_name: string;
    description?: string;
    is_admin?: boolean;
    can_manage_models?: boolean;
    can_manage_datasources?: boolean;
}): Promise<SecurityRole>;
export declare function listPolicies(pool: Pool, roleId?: string): Promise<AccessPolicy[]>;
export declare function upsertPolicy(pool: Pool, input: {
    id?: string;
    role_id: string;
    cube_name: string;
    policy_type: 'RLS' | 'OLS';
    definition: Record<string, any>;
}): Promise<AccessPolicy>;
export declare function deletePolicy(pool: Pool, id: string): Promise<boolean>;
//# sourceMappingURL=securityStore.d.ts.map