import { Pool } from 'pg';
import { SchemaFileRepository, FileContent } from '../types';
export declare class PostgresSchemaRepository implements SchemaFileRepository {
    protected readonly pool: Pool;
    protected readonly virtualPath: string;
    constructor(pool: Pool, virtualPath?: string);
    localPath(): string;
    dataSchemaFiles(): Promise<FileContent[]>;
}
export declare function createPostgresRepository(pool: Pool, virtualPath?: string): SchemaFileRepository;
//# sourceMappingURL=PostgresSchemaRepository.d.ts.map