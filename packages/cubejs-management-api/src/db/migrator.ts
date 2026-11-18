import fs from 'fs-extra';
import path from 'path';
import { Pool } from 'pg';

export async function runMigrations(pool: Pool, options: { includeSampleData?: boolean } = {}): Promise<void> {
  const sqlDir = path.resolve(__dirname, '../../sql');
  const initialSchemaPath = path.join(sqlDir, '001_initial_schema.sql');

  if (await fs.pathExists(initialSchemaPath)) {
    const initialSchemaSql = await fs.readFile(initialSchemaPath, 'utf8');
    await pool.query(initialSchemaSql);
  } else {
    throw new Error(`Migration file not found at ${initialSchemaPath}`);
  }

  if (options.includeSampleData) {
    const sampleDataPath = path.join(sqlDir, '002_sample_data.sql');
    if (await fs.pathExists(sampleDataPath)) {
      const sampleDataSql = await fs.readFile(sampleDataPath, 'utf8');
      await pool.query(sampleDataSql);
    }
  }

  const securityRolesPath = path.join(sqlDir, '004_security_roles.sql');
  if (await fs.pathExists(securityRolesPath)) {
    const securityRolesSql = await fs.readFile(securityRolesPath, 'utf8');
    await pool.query(securityRolesSql);
  }
}
