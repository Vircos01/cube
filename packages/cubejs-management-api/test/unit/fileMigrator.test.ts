import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { exportModelsToDirectory, importModelsFromDirectory } from '../../src/repository/fileMigrator';

describe('File Migrator (Import & Export)', () => {
  let tmpDir: string;
  let mockPool: any;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cube-migrator-test-'));
    mockPool = {
      query: jest.fn(),
      connect: jest.fn(),
    };
  });

  afterEach(async () => {
    await fs.remove(tmpDir);
  });

  it('exports active models to directory', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { file_name: 'Orders.cube.yml', content: 'cubes:\n  - name: Orders' },
        { file_name: 'Users.cube.yml', content: 'cubes:\n  - name: Users' },
      ],
    });

    const result = await exportModelsToDirectory(mockPool, tmpDir);
    expect(result.count).toBe(2);

    const ordersExists = await fs.pathExists(path.join(tmpDir, 'Orders.cube.yml'));
    const usersExists = await fs.pathExists(path.join(tmpDir, 'Users.cube.yml'));
    expect(ordersExists).toBe(true);
    expect(usersExists).toBe(true);

    const content = await fs.readFile(path.join(tmpDir, 'Orders.cube.yml'), 'utf8');
    expect(content).toBe('cubes:\n  - name: Orders');
  });

  it('imports yaml files from directory', async () => {
    const filePath = path.join(tmpDir, 'Products.cube.yml');
    await fs.writeFile(filePath, 'cubes:\n  - name: Products\n    sql_table: products');

    // Mock: model does not exist yet
    mockPool.query.mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('SELECT id, name FROM semantic_models')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    // Mock client for withTransaction
    const mockClient = {
      query: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO semantic_models')) {
          return { rows: [{ id: 'model-p', name: 'Products' }] };
        }
        if (sql.includes('INSERT INTO model_revisions')) {
          return { rows: [{ id: 'rev-p', revision_number: 1 }] };
        }
        if (sql.includes('UPDATE schema_version_tracker') || sql.includes('INSERT INTO schema_version_tracker')) {
          return { rows: [{ version: 2, version_hash: 'hash' }] };
        }
        return { rows: [] };
      }),
      release: jest.fn(),
    };
    mockPool.connect.mockResolvedValue(mockClient);

    const result = await importModelsFromDirectory(mockPool, tmpDir, 'test-importer');
    expect(result.imported.length).toBe(1);
    expect(result.imported[0].modelName).toBe('Products');
    expect(result.imported[0].revision).toBe(1);
  });
});
