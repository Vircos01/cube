import { Pool } from 'pg';
export interface ImportResult {
    imported: Array<{
        fileName: string;
        modelName: string;
        revision: number;
    }>;
    skipped: Array<{
        fileName: string;
        reason: string;
    }>;
    errors: Array<{
        fileName: string;
        error: string;
    }>;
}
export interface ExportResult {
    exported: Array<{
        fileName: string;
        path: string;
    }>;
    count: number;
}
export declare function importModelsFromDirectory(pool: Pool, directoryPath: string, actor?: string): Promise<ImportResult>;
export declare function exportModelsToDirectory(pool: Pool, targetDirectory: string): Promise<ExportResult>;
//# sourceMappingURL=fileMigrator.d.ts.map