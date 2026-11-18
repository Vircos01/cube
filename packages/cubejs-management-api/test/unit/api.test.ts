import express from 'express';
import request from 'supertest';
import { createManagementRouter } from '../../src/api/router';
import * as modelStore from '../../src/repository/modelStore';

describe('Management REST API', () => {
  let app: express.Express;
  let mockPool: any;

  beforeEach(() => {
    mockPool = {
      query: jest.fn(),
      connect: jest.fn(),
    };

    app = express();
    app.use(express.json());
    app.use('/management/v1', createManagementRouter(mockPool, { apiSecret: 'test-secret' }));
  });

  it('GET /health returns status ok and schema version without auth', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [{ version: 5, version_hash: 'abc', updated_at: '2026-11-18T10:00:00Z' }],
    });

    const res = await request(app).get('/management/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.schemaVersion).toContain('v5_abc');
  });

  it('GET /models rejects with 401 when unauthenticated and dev mode is false', async () => {
    const oldDevMode = process.env.CUBEJS_DEV_MODE;
    process.env.CUBEJS_DEV_MODE = 'false';

    const res = await request(app).get('/management/v1/models');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Authorization header is required');

    if (oldDevMode !== undefined) {
      process.env.CUBEJS_DEV_MODE = oldDevMode;
    } else {
      delete process.env.CUBEJS_DEV_MODE;
    }
  });

  it('GET /models succeeds with correct Bearer token', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'model-1',
          name: 'Orders',
          model_type: 'cube',
          file_name: 'Orders.cube.yml',
          description: 'Orders',
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

    const res = await request(app)
      .get('/management/v1/models')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(res.body.models.length).toBe(1);
    expect(res.body.models[0].name).toBe('Orders');
  });

  it('POST /models/validate validates valid YAML in-memory', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] }); // getActiveSchemaFiles

    const validYaml = `
cubes:
  - name: Orders
    sql_table: public.orders
    dimensions:
      - name: id
        sql: id
        type: number
        primary_key: true
    measures:
      - name: count
        type: count
`;

    const res = await request(app)
      .post('/management/v1/models/validate')
      .set('Authorization', 'Bearer test-secret')
      .send({ content: validYaml, fileName: 'Orders.cube.yml' });

    if (!res.body.valid) {
      console.log('Validation errors:', JSON.stringify(res.body));
    }
    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.cubes.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /models/validate returns errors with details for broken schema', async () => {
    mockPool.query.mockResolvedValueOnce({ rows: [] });

    const brokenYaml = `
cubes:
  - name: Orders
    sql_table: public.orders
    dimensions:
      - name: id
        sql: id
       type: number
`;

    const res = await request(app)
      .post('/management/v1/models/validate')
      .set('Authorization', 'Bearer test-secret')
      .send({ content: brokenYaml, fileName: 'Orders.cube.yml' });

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  it('GET /datasources returns registered data sources with passwords redacted', async () => {
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'ds-1',
          name: 'remote_dw',
          db_type: 'postgres',
          host: 'db.corp.internal',
          port: 5432,
          database_name: 'analytics',
          username: 'ro_user',
          schema_name: 'public',
          ssl: true,
        },
      ],
    });

    const res = await request(app)
      .get('/management/v1/datasources')
      .set('Authorization', 'Bearer test-secret');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(1);
    expect(res.body[0].name).toBe('remote_dw');
    expect(res.body[0].password).toBeUndefined();
  });

  it('POST /datasources/preview-import detects existing model conflicts and validates batch', async () => {
    // 1. Existing active models
    mockPool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 'existing-orders-id',
          name: 'Orders',
          file_name: 'Orders.cube.yml',
          content: 'cubes:\n  - name: Orders\n    sql_table: public.orders\n',
        },
      ],
    });

    const res = await request(app)
      .post('/management/v1/datasources/preview-import')
      .set('Authorization', 'Bearer test-secret')
      .send({
        tables: [
          {
            schema: 'public',
            name: 'orders',
            columns: [
              { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
              { name: 'amount', type: 'numeric', nullable: false },
            ],
          },
          {
            schema: 'public',
            name: 'customers',
            columns: [
              { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
              { name: 'name', type: 'varchar', nullable: false },
            ],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.summary.total).toBe(2);
    expect(res.body.summary.toUpdate).toBe(1); // Orders already exists -> conflict / update
    expect(res.body.summary.toCreate).toBe(1); // Customers is new -> create

    const ordersPreview = res.body.items.find((i: any) => i.cubeName === 'Orders');
    expect(ordersPreview.isConflict).toBe(true);
    expect(ordersPreview.existingModelId).toBe('existing-orders-id');

    const customersPreview = res.body.items.find((i: any) => i.cubeName === 'Customers');
    expect(customersPreview.isConflict).toBe(false);
  });
});

