import { Pool } from 'pg';
import { getSchemaVersion } from './modelStore';

export function createSchemaVersionGetter(pool: Pool) {
  return async function schemaVersion(): Promise<string> {
    try {
      return await getSchemaVersion(pool);
    } catch (err: any) {
      console.error('[createSchemaVersionGetter] Error fetching schema version from PostgreSQL:', err.message);
      return 'fallback_schema_version';
    }
  };
}
