import { Pool, PoolClient } from 'pg';
import { SemanticModel, ModelRevision, SemanticModelWithActiveRevision, SemanticModelDetail, ModelType, AuditLogEntry } from '../types';
export declare function bumpSchemaVersion(client: Pool | PoolClient): Promise<string>;
export declare function getSchemaVersion(pool: Pool): Promise<string>;
/**
 * Log a structured, compliant audit entry
 */
export declare function logAudit(client: PoolClient | Pool, params: {
    action: string;
    model_id?: string | null;
    model_name?: string | null;
    previous_revision_id?: string | null;
    revision_id?: string | null;
    actor?: string | null;
    source?: string | null;
    result?: 'SUCCESS' | 'FAILED';
    error_message?: string | null;
    details?: Record<string, any> | null;
    ip_address?: string | null;
}): Promise<AuditLogEntry>;
export declare function getActiveSchemaFiles(pool: Pool | PoolClient, excludeModelId?: string): Promise<Array<{
    fileName: string;
    content: string;
}>>;
export declare function getAllModels(pool: Pool, options?: {
    includeDeleted?: boolean;
}): Promise<SemanticModelWithActiveRevision[]>;
export declare function getModelById(pool: Pool, id: string): Promise<SemanticModelDetail | null>;
export declare function createModel(pool: Pool, params: {
    name: string;
    model_type?: ModelType;
    file_name?: string;
    description?: string;
    content: string;
    content_format?: 'yaml' | 'json';
    change_summary?: string;
    git_commit_hash?: string;
    actor?: string;
    source?: string;
}): Promise<SemanticModelDetail>;
export declare function updateModel(pool: Pool, id: string, params: {
    content: string;
    content_format?: 'yaml' | 'json';
    change_summary?: string;
    description?: string;
    git_commit_hash?: string;
    actor?: string;
    source?: string;
    expectedRevisionNumber?: number;
    expectedRevisionId?: string;
    expectedVersion?: number;
}): Promise<SemanticModelDetail>;
export declare function rollbackModel(pool: Pool, modelId: string, targetRevisionNumber: number, actor?: string, source?: string): Promise<SemanticModelDetail>;
export declare function deleteModel(pool: Pool, id: string, actor?: string, source?: string): Promise<void>;
export declare function restoreModel(pool: Pool, id: string, actor?: string, source?: string): Promise<SemanticModelDetail>;
export declare function cleanupArchivedRevisions(pool: Pool, options?: {
    retentionDays?: number;
    keepMinRevisions?: number;
    actor?: string;
}): Promise<{
    deletedCount: number;
}>;
export interface BatchModelItem {
    name: string;
    file_name?: string;
    model_type?: ModelType;
    description?: string;
    content: string;
    content_format?: 'yaml' | 'json';
    change_summary?: string;
    git_commit_hash?: string;
}
export interface BatchUpsertResultItem {
    model: SemanticModel;
    revision: ModelRevision;
    isUpdate: boolean;
}
export declare function batchUpsertModels(pool: Pool, items: BatchModelItem[], actor?: string, source?: string): Promise<BatchUpsertResultItem[]>;
//# sourceMappingURL=modelStore.d.ts.map