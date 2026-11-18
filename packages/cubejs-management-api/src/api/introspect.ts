import { Pool } from 'pg';
import { IntrospectResult, IntrospectTable } from '../types';

export async function introspectPostgresDatabase(pool: Pool, schema: string = 'public'): Promise<IntrospectResult> {
  const tablesQuery = `
    SELECT 
      table_schema,
      table_name,
      column_name,
      data_type,
      is_nullable,
      column_default
    FROM information_schema.columns
    WHERE table_schema = $1
      AND table_name NOT IN ('spatial_ref_sys', 'semantic_models', 'model_revisions', 'audit_logs', 'schema_version_tracker')
    ORDER BY table_schema, table_name, ordinal_position;
  `;

  const pkQuery = `
    SELECT
      tc.table_schema,
      tc.table_name,
      kcu.column_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'PRIMARY KEY'
      AND tc.table_schema = $1;
  `;

  const [colsRes, pkRes] = await Promise.all([
    pool.query(tablesQuery, [schema]),
    pool.query(pkQuery, [schema]),
  ]);

  const pks = new Set<string>();
  for (const row of pkRes.rows) {
    pks.add(`${row.table_schema}.${row.table_name}.${row.column_name}`);
  }

  const tableMap = new Map<string, IntrospectTable>();

  for (const row of colsRes.rows) {
    const key = `${row.table_schema}.${row.table_name}`;
    if (!tableMap.has(key)) {
      tableMap.set(key, {
        schema: row.table_schema,
        name: row.table_name,
        columns: [],
      });
    }

    const isPrimaryKey = pks.has(`${row.table_schema}.${row.table_name}.${row.column_name}`);

    tableMap.get(key)!.columns.push({
      name: row.column_name,
      type: row.data_type,
      nullable: row.is_nullable === 'YES',
      isPrimaryKey,
    });
  }

  return {
    tables: Array.from(tableMap.values()),
  };
}
