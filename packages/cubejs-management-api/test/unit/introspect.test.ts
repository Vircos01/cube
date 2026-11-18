import { generateCubeDef, toCubeName } from '../../src/api/introspect';
import { validateBatchSchemas } from '../../src/compiler/validator';
import { IntrospectTable } from '../../src/types';

describe('Introspect & Safe Cube Generation', () => {
  const usersTable: IntrospectTable = {
    schema: 'public',
    name: 'sample_users',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
      { name: 'name', type: 'varchar', nullable: false },
      { name: 'city', type: 'varchar', nullable: true },
    ],
  };

  const ordersTable: IntrospectTable = {
    schema: 'public',
    name: 'sample_orders',
    columns: [
      { name: 'id', type: 'integer', nullable: false, isPrimaryKey: true },
      { name: 'user_id', type: 'integer', nullable: false },
      { name: 'amount', type: 'numeric', nullable: false },
    ],
    foreignKeys: [
      {
        column: 'user_id',
        foreignSchema: 'public',
        foreignTable: 'sample_users',
        foreignColumn: 'id',
      },
    ],
  };

  it('toCubeName strips prefixes and camelCases correctly', () => {
    expect(toCubeName('sample_users')).toBe('Users');
    expect(toCubeName('sample_order_items')).toBe('OrderItems');
    expect(toCubeName('tbl_customers')).toBe('Customers');
  });

  it('P1 Finding 1: Single table import skips joins to non-existent cubes to prevent broken schema', () => {
    // Single table import: sample_users is NOT in import batch, and NOT in existing models
    const def = generateCubeDef(ordersTable, [ordersTable], {
      autoJoins: true,
      existingCubeNames: [],
    });

    expect(def.parsed.cubes[0].joins).toBeUndefined();
    expect(def.skippedJoins).toBeDefined();
    expect(def.skippedJoins!.length).toBe(1);
    expect(def.skippedJoins![0]).toContain("target cube 'Users' is not in the import batch or existing models");
    expect(def.yaml).not.toContain('name: Users');
  });

  it('P1 Finding 1: Single table import creates join if target cube already exists in VAS models', () => {
    // sample_users is already an existing cube in VAS
    const def = generateCubeDef(ordersTable, [ordersTable], {
      autoJoins: true,
      existingCubeNames: ['Users'],
    });

    expect(def.parsed.cubes[0].joins).toBeDefined();
    expect(def.parsed.cubes[0].joins.length).toBe(1);
    expect(def.parsed.cubes[0].joins[0].name).toBe('Users');
    expect(def.yaml).toContain('name: Users');
  });

  it('P1 Finding 1: Batch import creates join when related table is in the same import batch', () => {
    // Both orders and users are selected together in the batch
    const def = generateCubeDef(ordersTable, [ordersTable, usersTable], {
      autoJoins: true,
    });

    expect(def.parsed.cubes[0].joins).toBeDefined();
    expect(def.parsed.cubes[0].joins[0].name).toBe('Users');
  });

  it('P1 Finding 2: Propagates data_source to cube YAML when targeting external database', () => {
    const def = generateCubeDef(ordersTable, [ordersTable], {
      dataSource: 'external_dwh',
    });

    expect(def.parsed.cubes[0].data_source).toBe('external_dwh');
    expect(def.yaml).toContain('data_source: external_dwh');
  });

  it('P1 Finding 2: Omits data_source or leaves default when default database', () => {
    const def = generateCubeDef(ordersTable, [ordersTable], {
      dataSource: 'default',
    });

    expect(def.parsed.cubes[0].data_source).toBeUndefined();
    expect(def.yaml).not.toContain('data_source:');
  });

  it('P2 Finding 3: validateBatchSchemas verifies multi-table batch before writing to DB', async () => {
    const usersDef = generateCubeDef(usersTable, [usersTable, ordersTable]);
    const ordersDef = generateCubeDef(ordersTable, [usersTable, ordersTable]);

    const batch = [
      { fileName: usersDef.fileName, content: usersDef.yaml },
      { fileName: ordersDef.fileName, content: ordersDef.yaml },
    ];

    const validation = await validateBatchSchemas(batch, []);
    expect(validation.valid).toBe(true);
    if (validation.valid) {
      expect(validation.cubes.length).toBe(2);
    }
  });
});
