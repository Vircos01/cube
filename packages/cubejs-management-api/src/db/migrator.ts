import fs from 'fs-extra';
import path from 'path';
import { Pool } from 'pg';

export async function runMigrations(pool: Pool, options: { includeSampleData?: boolean } = {}): Promise<void> {
  const sqlDir = path.resolve(__dirname, '../../sql');
  if (!(await fs.pathExists(sqlDir))) {
    throw new Error(`SQL directory not found at ${sqlDir}`);
  }

  const files = (await fs.readdir(sqlDir)).filter(f => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (file.includes('sample_data') && !options.includeSampleData) {
      continue;
    }
    const filePath = path.join(sqlDir, file);
    const sql = await fs.readFile(filePath, 'utf8');
    await pool.query(sql);
  }
}
