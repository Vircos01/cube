import { Pool } from 'pg';
import { DataSourceRecord, CreateDataSourceInput } from '../types';

export async function upsertDataSource(pool: Pool, input: CreateDataSourceInput): Promise<DataSourceRecord> {
  const dbType = input.db_type || 'postgres';
  const schemaName = input.schema_name || 'public';
  const ssl = !!input.ssl;

  const res = await pool.query(`
    INSERT INTO data_sources (name, db_type, host, port, database_name, username, password, schema_name, ssl, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
    ON CONFLICT (name) DO UPDATE SET
      db_type = EXCLUDED.db_type,
      host = EXCLUDED.host,
      port = EXCLUDED.port,
      database_name = EXCLUDED.database_name,
      username = EXCLUDED.username,
      password = EXCLUDED.password,
      schema_name = EXCLUDED.schema_name,
      ssl = EXCLUDED.ssl,
      updated_at = NOW()
    RETURNING *
  `, [
    input.name,
    dbType,
    input.host,
    input.port,
    input.database_name,
    input.username,
    input.password || '',
    schemaName,
    ssl,
  ]);

  return res.rows[0];
}

export async function getDataSource(pool: Pool, name: string): Promise<DataSourceRecord | null> {
  const res = await pool.query('SELECT * FROM data_sources WHERE name = $1', [name]);
  if (res.rows.length === 0) {
    return null;
  }
  return res.rows[0];
}

export async function listDataSources(pool: Pool): Promise<DataSourceRecord[]> {
  const res = await pool.query('SELECT id, name, db_type, host, port, database_name, username, schema_name, ssl, created_at, updated_at FROM data_sources ORDER BY name ASC');
  return res.rows;
}

export async function deleteDataSource(pool: Pool, name: string): Promise<boolean> {
  const res = await pool.query('DELETE FROM data_sources WHERE name = $1 RETURNING id', [name]);
  return res.rows.length > 0;
}
