import { Pool, PoolClient } from 'pg';
import { SemanticModelWithActiveRevision, SemanticModelDetail, ModelType } from '../types';
export declare function bumpSchemaVersion(client: Pool | PoolClient): Promise<string>;
export declare function getSchemaVersion(pool: Pool): Promise<string>;
export declare function getActiveSchemaFiles(pool: Pool): Promise<Array<{
    fileName: string;
    content: string;
}>>;
export declare function getAllModels(pool: Pool): Promise<SemanticModelWithActiveRevision[]>;
export declare function getModelById(pool: Pool, id: string): Promise<SemanticModelDetail | null>;
export declare function createModel(pool: Pool, params: {
    name: string;
    model_type?: ModelType;
    file_name?: string;
    description?: string;
    content: string;
    content_format?: 'yaml' | 'json';
    change_summary?: string;
    actor?: string;
}): Promise<SemanticModelDetail>;
export declare function updateModel(pool: Pool, id: string, params: {
    content: string;
    content_format?: 'yaml' | 'json';
    change_summary?: string;
    description?: string;
    actor?: string;
}): Promise<SemanticModelDetail>;
export declare function rollbackModel(pool: Pool, modelId: string, targetRevisionNumber: number, actor?: string): Promise<SemanticModelDetail>;
export declare function deleteModel(pool: Pool, id: string, actor?: string): Promise<void>;
//# sourceMappingURL=modelStore.d.ts.map