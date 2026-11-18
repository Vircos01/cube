import { PostgresSchemaRepository } from '../../src/repository/PostgresSchemaRepository';
import { createSchemaVersionGetter } from '../../src/repository/schemaVersion';
import * as modelStore from '../../src/repository/modelStore';

describe('PostgresSchemaRepository & SchemaVersion', () => {
  let mockPool: any;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
      connect: jest.fn(),
    };
  });

  it('PostgresSchemaRepository returns active schema files from database', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { file_name: 'Orders.cube.yml', content: 'cubes:\n  - name: Orders' },
        { file_name: 'Users.cube.yml', content: 'cubes:\n  - name: Users' },
      ],
    });

    const repo = new PostgresSchemaRepository(mockPool);
    const files = await repo.dataSchemaFiles();

    expect(mockPool.query).toHaveBeenCalledTimes(1);
    expect(files.length).toBe(2);
    expect(files[0].fileName).toBe('Orders.cube.yml');
    expect(files[0].content).toBe('cubes:\n  - name: Orders');
  });

  it('schemaVersionGetter returns formatted version string from tracker', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        { version: '42', version_hash: 'abc12345', updated_at: '2026-11-18T10:00:00Z' },
      ],
    });

    const getter = createSchemaVersionGetter(mockPool);
    const version = await getter();

    expect(version).toMatch(/^v42_abc12345_\d+$/);
  });

  it('schemaVersionGetter falls back gracefully on error', async () => {
    mockPool.query.mockRejectedValueOnce(new Error('Connection lost'));

    const getter = createSchemaVersionGetter(mockPool);
    const version = await getter();

    expect(version).toBe('fallback_schema_version');
  });

  it('getAllModels returns models with active revision', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'model-1',
          name: 'Orders',
          model_type: 'cube',
          file_name: 'Orders.cube.yml',
          description: 'Orders cube',
          is_active: true,
          created_at: new Date(),
          updated_at: new Date(),
          revision_id: 'rev-1',
          revision_number: 1,
          content: 'cubes:\n  - name: Orders',
          content_format: 'yaml',
          change_summary: 'init',
          revision_status: 'active',
          created_by: 'admin',
          revision_created_at: new Date(),
        },
      ],
    });

    const models = await modelStore.getAllModels(mockPool);
    expect(models.length).toBe(1);
    expect(models[0].name).toBe('Orders');
    expect(models[0].active_revision?.revision_number).toBe(1);
  });
});
