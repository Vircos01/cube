import { SchemaFileRepository, FileContent } from '@cubejs-backend/shared';
import { ValidationResult } from '../types';
export declare class MemorySchemaRepository implements SchemaFileRepository {
    protected readonly files: FileContent[];
    protected readonly pathStr: string;
    constructor(files: FileContent[], pathStr?: string);
    localPath(): string;
    dataSchemaFiles(): Promise<FileContent[]>;
}
export declare function validateSchemaContent(content: string, fileName?: string, existingFiles?: FileContent[], dialect?: string): Promise<ValidationResult>;
//# sourceMappingURL=validator.d.ts.map