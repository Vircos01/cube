import { Pool } from 'pg';
import { SchemaFileRepository, FileContent } from '../types';
import { getActiveSchemaFiles } from './modelStore';

export class PostgresSchemaRepository implements SchemaFileRepository {
  public constructor(
    protected readonly pool: Pool,
    protected readonly virtualPath: string = '/cube/conf/schema'
  ) {}

  public localPath(): string {
    return this.virtualPath;
  }

  public async dataSchemaFiles(): Promise<FileContent[]> {
    const files = await getActiveSchemaFiles(this.pool);
    return files.map(file => ({
      fileName: file.fileName,
      content: file.content,
      readOnly: false,
    }));
  }
}

export function createPostgresRepository(pool: Pool, virtualPath?: string): SchemaFileRepository {
  return new PostgresSchemaRepository(pool, virtualPath);
}
